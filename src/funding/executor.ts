/**
 * Books the one conversion that funds a replacement, with the payout gateway's discipline:
 *
 * - The intent and its request_id are committed before any network call, and the database allows one INTENT, BOOKED or
 *   SETTLED conversion per replacement (`one_conversion_per_replacement`), so no retry, crash or second process can buy twice.
 * - An ambiguous answer (timeout, 5xx, lost reply, `kill -9`) is resolved by looking the same request_id up
 *   (`GET /api/v1/fx/conversions?request_id=`), never by minting a new one. The sandbox answers a reused request_id with
 *   `400 invalid_argument` and no conversion id (verified 2026-11-03), so that answer is resolved by the same lookup.
 * - Wallets are read again just before the intent is written: the conversion must still be needed, must buy exactly the
 *   shortfall (never more), and must leave the wallet it sells from at or above its reserve floor.
 * - A quote is booked once (unique column; the sandbox reports quotes as MULTI_USE) and only before it expires. An intent
 *   whose quote expired with nothing at Airwallex is released by itself: Airwallex refuses an expired quote (`expired_quote`)
 *   and the send guard stops any of our own late sends.
 * - Nothing is sent for an escalated or closed incident, or on a ledger that does not verify.
 */
import { z } from "zod";
import { AwxHttpError, type BalanceApi, type Conversion, type CreateConversionRequest, type FxApi } from "../airwallex/types";
import { fundingNeed, type CommanderPolicy } from "../commander/policy";
import { lookupFailure } from "../domain/playbook";
import {
  ApprovalRejected,
  DuplicateConversionError,
  FundingRefused,
  LedgerMismatchError,
  ObligationNotPayable,
  StateConflict,
} from "../errors";
import { classifyConversion, holdsFundingLock, type ConversionAttempt, type ConversionState } from "../ledger/conversions";
import type { Ledger } from "../ledger/ledger";
import { formatMinor, fromMinor, toMinor } from "../money";
import { verifyFundingApproval, type FundingApproval, type FundingApprovalPayload } from "./approval";

export type FundingOutcome = "BOOKED" | "ADOPTED_DUPLICATE" | "ADOPTED_AFTER_AMBIGUITY" | "PENDING_RECOVERY" | "REJECTED";

export interface FundingResult {
  outcome: FundingOutcome;
  conversion: ConversionAttempt;
  /** Wallets (minor units) re-read after the conversion settled; null when it has not settled or they could not be read. */
  walletsAfter: Record<string, number> | null;
}

export interface FundingExecutorConfig {
  ledger: Ledger;
  api: FxApi & BalanceApi;
  approvalSecret: string;
  /** The same policy the Commander plans with: reserve floors, funding sources, smallest conversion. */
  policy: CommanderPolicy;
  now?: () => Date;
  newRequestId?: () => string;
  sleep?: (ms: number) => Promise<void>;
  /** How long after its quote expired an INTENT with no conversion at Airwallex is released. A late send cannot land by then. */
  expiredIntentGraceMs?: number;
}

/** A quote this close to expiry is not sent: the request could arrive after it. */
export const QUOTE_SEND_MARGIN_MS = 5_000;
const RATE_LIMIT_RETRIES = 3;
const MAX_RATE_LIMIT_WAIT_MS = 30_000;
const MIN_RATE_LIMIT_BACKOFF_MS = 250;
const DEFAULT_EXPIRED_INTENT_GRACE_MS = 10 * 60_000;
/** Lookups reach back this far before the intent, for clock skew with Airwallex. */
const LOOKUP_LEAD_MS = 3600_000;
const STATUS_RANK: Record<string, number> = { SCHEDULED: 0, OVERDUE: 1, SETTLED: 2, CANCELLED: 3 };

const FundingRefSchema = z.looseObject({ fundingId: z.string() });
const AmbiguousSchema = z.looseObject({ fundingId: z.string(), error: z.string() });
const OrphanSchema = z.looseObject({ fundingId: z.string(), conversionId: z.string() });
const DuplicateBodySchema = z.looseObject({ source: z.string() });

/** Any 4xx other than 408/429 means Airwallex did not process the request. */
const isDefinitiveRejection = (error: AwxHttpError): boolean =>
  error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;

/** Airwallex already holds a conversion under this request_id: `duplicate_request_id`, or the sandbox's `invalid_argument` on `request_id`. */
const isReusedRequestId = (error: AwxHttpError): boolean =>
  error.status === 400 && (error.code === "duplicate_request_id" || DuplicateBodySchema.safeParse(error.body).data?.source === "request_id");

class SendRefused extends Error {
  constructor(readonly why: "not_intent" | "escalated", readonly row: ConversionAttempt) {
    super(why === "escalated" ? `obligation is escalated; conversion ${row.id} is not sent` : `conversion ${row.id} is ${row.state}, not an open intent`);
    this.name = "SendRefused";
  }
}

export class FundingExecutor {
  private readonly ledger: Ledger;
  private readonly api: FxApi & BalanceApi;
  private readonly secret: string;
  private readonly policy: CommanderPolicy;
  private readonly now: () => Date;
  private readonly newRequestId: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly graceMs: number;

  constructor(config: FundingExecutorConfig) {
    if (config.approvalSecret.length < 32) throw new Error("approval secret must be at least 32 characters");
    this.ledger = config.ledger;
    this.api = config.api;
    this.secret = config.approvalSecret;
    this.policy = config.policy;
    this.now = config.now ?? (() => new Date());
    this.newRequestId = config.newRequestId ?? (() => crypto.randomUUID());
    this.sleep = config.sleep ?? ((ms) => Bun.sleep(ms));
    this.graceMs = config.expiredIntentGraceMs ?? DEFAULT_EXPIRED_INTENT_GRACE_MS;
  }

  /**
   * Books the conversion an approval names, exactly once. The approval is verified, the wallets are read again, and the
   * intent is committed before Airwallex is called; any later crash is resolved by `recover`.
   */
  async book(approval: FundingApproval): Promise<FundingResult> {
    const p = verifyFundingApproval(approval, this.secret, this.now());
    const wallets = await this.readWallets();
    if (wallets === null) throw new FundingRefused(p.obligationId, ["The wallet balances could not be read just before booking, so nothing was converted."]);
    return this.execute(this.begin(p, wallets), "submit");
  }

  /** Every wallet's available balance in minor units, or null when Airwallex could not be read. */
  async readWallets(): Promise<Record<string, number> | null> {
    try {
      const rows = await this.api.getBalances();
      return Object.fromEntries(rows.map((b) => [b.currency, toMinor(b.available_amount, b.currency)]));
    } catch {
      return null;
    }
  }

  /**
   * Resolves conversions left in INTENT: adopts what Airwallex holds for the request_id, re-sends the same request_id
   * while its quote is still good, and releases an intent whose quote expired with nothing behind it. One that cannot be
   * resolved never stops the rest; the first unexpected failure is rethrown at the end.
   */
  async recover(obligationId?: string): Promise<FundingResult[]> {
    const results: FundingResult[] = [];
    let failure: unknown = null;
    for (const row of this.ledger.conversionsIn(["INTENT"], obligationId)) {
      try {
        results.push(await this.recoverOne(row));
      } catch (error) {
        if (!(error instanceof LedgerMismatchError) && !(error instanceof StateConflict)) failure ??= error;
        results.push(this.result("PENDING_RECOVERY", this.ledger.requireConversion(row.id)));
      }
    }
    if (failure !== null) throw failure;
    return results;
  }

  /** Pulls the latest status of every booked (not yet settled) conversion. */
  async sync(obligationId?: string): Promise<ConversionAttempt[]> {
    const updated: ConversionAttempt[] = [];
    let failure: unknown = null;
    for (const row of this.ledger.conversionsIn(["BOOKED"], obligationId)) {
      if (row.conversionId === null) continue;
      try {
        updated.push((await this.settled("BOOKED", this.adopt(row, this.checked(row, await this.api.getConversion(row.conversionId)), "sync"))).conversion);
      } catch (error) {
        if (!(error instanceof LedgerMismatchError)) failure ??= error;
      }
    }
    if (failure !== null) throw failure;
    return updated;
  }

  /** Recover and sync one incident's conversions (or all of them): what an assessment or the sweep runs first. */
  async refresh(obligationId?: string): Promise<void> {
    await this.recover(obligationId);
    await this.sync(obligationId);
  }

  private async recoverOne(row: ConversionAttempt): Promise<FundingResult> {
    let found: Conversion | null;
    try {
      found = await this.lookup(row);
    } catch (error) {
      this.noteError(row, String(error));
      return this.result("PENDING_RECOVERY", this.ledger.requireConversion(row.id));
    }
    if (found) return this.settled("ADOPTED_AFTER_AMBIGUITY", this.adopt(row, this.checked(row, found), "recover_lookup"));
    const expiresAt = Date.parse(row.quoteValidTo);
    const now = this.now().getTime();
    if (now > expiresAt + this.graceMs) return this.result("REJECTED", this.abandon(row, `quote expired at ${row.quoteValidTo} and Airwallex has no conversion for request_id ${row.requestId}`));
    if (now < expiresAt - QUOTE_SEND_MARGIN_MS) return this.execute(row, "recover");
    return this.result("PENDING_RECOVERY", row);
  }

  // ---- phase 1: durable intent ----------------------------------------------------------------------------------

  private begin(p: FundingApprovalPayload, wallets: Record<string, number>): ConversionAttempt {
    return this.ledger.tx(() => {
      const chain = this.ledger.verifyChain();
      if (!chain.ok) throw new ObligationNotPayable(p.obligationId, `ledger does not verify (${chain.reason}); a person must investigate`);
      const obligation = this.ledger.getObligation(p.obligationId);
      if (!obligation) throw new ObligationNotPayable(p.obligationId, "unknown obligation");
      if (obligation.status === "CLOSED") throw new ObligationNotPayable(obligation.id, "obligation is closed");
      if (obligation.status === "ESCALATED") throw new ObligationNotPayable(obligation.id, `escalated (${obligation.escalationReason}); nothing is converted for it`);
      if (this.ledger.fundingNonceUsed(p.nonce)) throw new ApprovalRejected("replayed", "funding approval nonce already used");

      /** `replan`: the wallets or the quote moved since the plan, so a fresh assessment and quote may succeed. */
      const refuse = (reason: string, replan = false): never => {
        throw new FundingRefused(obligation.id, [reason], null, replan);
      };
      const latest = this.ledger.attemptsFor(obligation.id).at(-1) ?? null;
      if (latest?.id !== p.forAttemptId) throw new ApprovalRejected("stale", `approval funds the replacement of ${p.forAttemptId}, latest attempt is ${latest?.id ?? "none"}`);
      if (latest.state !== "DEAD") refuse(`attempt ${latest.seq} is ${latest.state}, not cancelled with the money back, so it may not be replaced and nothing is converted for it.`);
      // Funding exists for one kind of replacement only: a transient failure, provably cancelled, that the playbook replaces.
      const entry = lookupFailure(latest.failureCode);
      if (entry.replace !== "AUTO") refuse(`failure ${latest.failureCode ?? "(no code)"} is never replaced automatically, so nothing is converted for it.`);
      if (p.buyCurrency !== obligation.currency || latest.currency !== obligation.currency) refuse(`a conversion for this incident must buy ${obligation.currency}.`);
      if (!this.policy.fundingSources.includes(p.sellCurrency) || p.sellCurrency === p.buyCurrency) refuse(`${p.sellCurrency} is not a wallet Tessera may sell.`);
      if (this.ledger.conversionsFor(obligation.id).some((c) => c.forAttemptId === latest.id && holdsFundingLock(c.state))) {
        throw new DuplicateConversionError(obligation.id, latest.id);
      }
      if (this.ledger.quoteUsed(p.quoteId)) refuse(`quote ${p.quoteId} was already booked once; a quote is single-use.`);
      if (Date.parse(p.quoteValidTo) - this.now().getTime() < QUOTE_SEND_MARGIN_MS) {
        refuse(`quote ${p.quoteId} expired (or expires within ${QUOTE_SEND_MARGIN_MS / 1000}s) at ${p.quoteValidTo}; get a fresh quote and plan again.`, true);
      }

      // The wallets as they are now, not as they were when the plan was made.
      const need = fundingNeed(latest, wallets, this.policy);
      const money = (minor: number, currency: string) => formatMinor(minor, currency);
      if (need.shortfallMinor <= 0) refuse(`the ${need.currency} wallet already covers the replacement and its ${money(need.floorMinor, need.currency)} reserve; nothing needs converting.`, true);
      if (p.buyMinor > need.buyMinor) refuse(`this would buy ${money(p.buyMinor, p.buyCurrency)} but only ${money(need.buyMinor, need.currency)} is missing; Tessera never converts more than the shortfall. Plan again.`, true);
      if (p.buyMinor < need.buyMinor) refuse(`this would buy ${money(p.buyMinor, p.buyCurrency)} but ${money(need.buyMinor, need.currency)} is missing, so the replacement would still be short. Plan again.`, true);
      const sourceAvailable = wallets[p.sellCurrency] ?? 0;
      const sourceFloor = this.policy.reserveFloorMinor[p.sellCurrency] ?? 0;
      if (sourceAvailable - p.sellMinor < sourceFloor) {
        refuse(`selling ${money(p.sellMinor, p.sellCurrency)} would take the ${p.sellCurrency} wallet (${money(sourceAvailable, p.sellCurrency)}) below its ${money(sourceFloor, p.sellCurrency)} reserve.`, true);
      }

      const row = this.ledger.insertConversion({
        obligationId: obligation.id, forAttemptId: latest.id, requestId: this.newRequestId(), approvalNonce: p.nonce,
        quoteId: p.quoteId, currencyPair: p.currencyPair, buyCurrency: p.buyCurrency, buyMinor: p.buyMinor, sellCurrency: p.sellCurrency,
        sellMinor: p.sellMinor, rate: p.rate, quoteValidTo: p.quoteValidTo,
      });
      this.ledger.append(obligation.id, "FUNDING_INTENT", {
        fundingId: row.id,
        forAttemptId: row.forAttemptId,
        requestId: row.requestId,
        nonce: p.nonce,
        mode: p.mode,
        approver: p.approver,
        note: p.note ?? null,
        evidenceHash: p.evidenceHash,
        terms: {
          quoteId: row.quoteId, currencyPair: row.currencyPair, buyCurrency: row.buyCurrency, buyMinor: row.buyMinor,
          sellCurrency: row.sellCurrency, sellMinor: row.sellMinor, rate: row.rate, quoteValidTo: row.quoteValidTo,
        },
        walletsBefore: { [need.currency]: need.availableMinor, [p.sellCurrency]: sourceAvailable },
      });
      return row;
    });
  }

  // ---- phase 2: network -----------------------------------------------------------------------------------------

  private async execute(row: ConversionAttempt, origin: "submit" | "recover"): Promise<FundingResult> {
    const request: CreateConversionRequest = {
      request_id: row.requestId,
      quote_id: row.quoteId,
      buy_currency: row.buyCurrency,
      sell_currency: row.sellCurrency,
      buy_amount: fromMinor(row.buyMinor, row.buyCurrency),
    };
    try {
      const conversion = await this.create(row, request);
      return this.settled("BOOKED", this.adoptSent(row, this.checked(row, conversion), "create"));
    } catch (error) {
      if (error instanceof SendRefused) return this.refusedSend(error);
      if (error instanceof LedgerMismatchError || error instanceof StateConflict) throw error;
      if (error instanceof AwxHttpError) {
        if (isReusedRequestId(error)) {
          const existing = await this.lookup(row).catch(() => null);
          if (existing) return this.settled("ADOPTED_DUPLICATE", this.adoptSent(row, this.checked(row, existing), "duplicate_request_id"));
        } else if (isDefinitiveRejection(error) && origin === "submit") {
          // Only a first send is trusted to be "not processed"; on the recover path a 4xx may hide an earlier send that landed.
          return this.result("REJECTED", this.abandon(row, `${error.code}: ${error.message}`));
        }
      }
      return this.resolveAmbiguity(row, error);
    }
  }

  /** Re-reads the intent before every send (the first, and each resend after a 429 wait). */
  private guardSend(row: ConversionAttempt): void {
    this.ledger.tx(() => {
      const current = this.ledger.requireConversion(row.id);
      if (current.state !== "INTENT") throw new SendRefused("not_intent", current);
      if (this.ledger.requireObligation(current.obligationId).status === "ESCALATED") throw new SendRefused("escalated", current);
    });
  }

  private async create(row: ConversionAttempt, request: CreateConversionRequest): Promise<Conversion> {
    for (let retry = 0; ; retry++) {
      this.guardSend(row);
      try {
        return await this.api.createConversion(request);
      } catch (error) {
        if (!(error instanceof AwxHttpError) || error.status !== 429 || retry >= RATE_LIMIT_RETRIES) throw error;
        const backoff = MIN_RATE_LIMIT_BACKOFF_MS * 2 ** retry;
        await this.sleep(Math.min(Math.max(error.retryAfterMs ?? 1_000 * 2 ** retry, backoff), MAX_RATE_LIMIT_WAIT_MS));
      }
    }
  }

  private async refusedSend(refusal: SendRefused): Promise<FundingResult> {
    if (refusal.why === "escalated") {
      try {
        const found = await this.lookup(refusal.row);
        if (found) return this.result("ADOPTED_AFTER_AMBIGUITY", this.adopt(refusal.row, this.checked(refusal.row, found), "escalated_lookup"));
      } catch (error) {
        if (error instanceof LedgerMismatchError) throw error;
        this.noteError(refusal.row, String(error));
      }
      return this.result("PENDING_RECOVERY", this.ledger.requireConversion(refusal.row.id));
    }
    const current = this.ledger.requireConversion(refusal.row.id);
    if (current.state === "ABANDONED") throw new StateConflict(`conversion ${current.id} was released while its create was waiting to be sent; nothing was sent`);
    return this.result("ADOPTED_AFTER_AMBIGUITY", current);
  }

  /** The create may or may not have reached Airwallex: look the same request_id up, never mint another. */
  private async resolveAmbiguity(row: ConversionAttempt, cause: unknown): Promise<FundingResult> {
    const message = cause instanceof Error ? cause.message : String(cause);
    this.ledger.tx(() => {
      const last = this.ledger
        .events(row.obligationId)
        .findLast((e) => e.type === "FUNDING_AMBIGUOUS" && FundingRefSchema.safeParse(e.payload).data?.fundingId === row.id);
      if (last && AmbiguousSchema.safeParse(last.payload).data?.error === message) return;
      this.ledger.updateConversion(row.id, { lastError: message });
      this.ledger.append(row.obligationId, "FUNDING_AMBIGUOUS", { fundingId: row.id, requestId: row.requestId, error: message });
    });
    try {
      const found = await this.lookup(row);
      if (found) return this.settled("ADOPTED_AFTER_AMBIGUITY", this.adoptSent(row, this.checked(row, found), "ambiguity_lookup"));
    } catch (lookupError) {
      if (lookupError instanceof LedgerMismatchError || lookupError instanceof StateConflict) throw lookupError;
    }
    return this.result("PENDING_RECOVERY", this.ledger.requireConversion(row.id));
  }

  private lookup(row: ConversionAttempt): Promise<Conversion | null> {
    return this.api.findConversionByRequestId(row.requestId, new Date(Date.parse(row.createdAt) - LOOKUP_LEAD_MS).toISOString());
  }

  private noteError(row: ConversionAttempt, message: string): void {
    if (this.ledger.requireConversion(row.id).lastError !== message) this.ledger.updateConversion(row.id, { lastError: message });
  }

  // ---- state transitions -----------------------------------------------------------------------------------------

  /** A conversion that shares our request_id but not our terms is never adopted: the obligation is escalated once. */
  private checked(row: ConversionAttempt, conversion: Conversion): Conversion {
    const matches =
      conversion.buy_currency === row.buyCurrency &&
      conversion.sell_currency === row.sellCurrency &&
      toMinor(conversion.buy_amount, conversion.buy_currency) === row.buyMinor &&
      toMinor(conversion.sell_amount, conversion.sell_currency) === row.sellMinor &&
      (conversion.request_id === undefined || conversion.request_id === row.requestId) &&
      (conversion.quote_id == null || conversion.quote_id === row.quoteId);
    if (matches) return conversion;
    const detail = `airwallex conversion ${conversion.conversion_id} (buy ${conversion.buy_amount} ${conversion.buy_currency}, sell ${conversion.sell_amount} ${conversion.sell_currency}) does not match the funding intent`;
    this.ledger.tx(() => {
      const obligation = this.ledger.requireObligation(row.obligationId);
      if (obligation.status === "ESCALATED" && obligation.escalationReason === detail) return;
      this.noteError(row, detail);
      this.ledger.append(row.obligationId, "FUNDING_MISMATCH", { fundingId: row.id, conversionId: conversion.conversion_id, detail });
      this.ledger.escalate(row.obligationId, detail);
    });
    throw new LedgerMismatchError(row.forAttemptId, detail);
  }

  private adoptSent(row: ConversionAttempt, conversion: Conversion, via: string): ConversionAttempt {
    const adopted = this.adopt(row, conversion, via);
    if (adopted.state === "ABANDONED") {
      throw new StateConflict(`conversion ${row.id} was released while its create was in flight, and Airwallex booked ${conversion.conversion_id} anyway; it is recorded and the incident escalated`);
    }
    return adopted;
  }

  private adopt(row: ConversionAttempt, conversion: Conversion, via: string): ConversionAttempt {
    return this.ledger.tx(() => {
      const current = this.ledger.requireConversion(row.id);
      if (current.state === "ABANDONED") return this.recordOrphan(current, conversion, via);
      const sameId = current.conversionId === null || current.conversionId === conversion.conversion_id;
      const incoming = STATUS_RANK[conversion.status];
      const applied = current.awxStatus === null ? undefined : STATUS_RANK[current.awxStatus];
      if (sameId && current.awxStatus === conversion.status) return current;
      if (sameId && incoming !== undefined && applied !== undefined && incoming < applied) return current;
      const next: ConversionState = classifyConversion(conversion.status);
      const updated = this.ledger.updateConversion(current.id, {
        state: next, conversionId: conversion.conversion_id, awxStatus: conversion.status, lastError: null,
      });
      this.ledger.append(current.obligationId, "FUNDING_STATUS", {
        fundingId: current.id, conversionId: conversion.conversion_id, from: current.awxStatus, to: conversion.status, via,
      });
      return updated;
    });
  }

  /** Airwallex booked a conversion for an intent that was released as never sent: recorded once, and a person looks. */
  private recordOrphan(current: ConversionAttempt, conversion: Conversion, via: string): ConversionAttempt {
    const seen = this.ledger.events(current.obligationId).some((e) => {
      if (e.type !== "FUNDING_AFTER_ABANDON") return false;
      const p = OrphanSchema.safeParse(e.payload);
      return p.success && p.data.fundingId === current.id && p.data.conversionId === conversion.conversion_id;
    });
    if (seen) return current;
    this.ledger.append(current.obligationId, "FUNDING_AFTER_ABANDON", {
      fundingId: current.id, conversionId: conversion.conversion_id, requestId: current.requestId, status: conversion.status, via,
    });
    this.ledger.escalate(
      current.obligationId,
      `conversion ${conversion.conversion_id} (${conversion.status}) exists at Airwallex for funding intent ${current.id}, which had been released as never booked; a person must decide what it is`,
    );
    return current;
  }

  private abandon(row: ConversionAttempt, reason: string): ConversionAttempt {
    return this.ledger.tx(() => {
      const released = this.ledger.abandonConversionIntent(row.id, reason);
      if (!released) return this.ledger.requireConversion(row.id);
      this.ledger.append(row.obligationId, "FUNDING_ABANDONED", { fundingId: row.id, requestId: row.requestId, reason });
      return released;
    });
  }

  /**
   * Once a conversion has settled, the wallets are read again and recorded once (`FUNDING_BALANCES`): the replacement is
   * decided on balances read after the money landed, never on the plan's arithmetic.
   */
  private async settled(outcome: FundingOutcome, row: ConversionAttempt): Promise<FundingResult> {
    if (row.state !== "SETTLED") return this.result(outcome, row);
    const wallets = await this.readWallets();
    const recorded = this.ledger
      .events(row.obligationId)
      .some((e) => e.type === "FUNDING_BALANCES" && FundingRefSchema.safeParse(e.payload).data?.fundingId === row.id);
    if (wallets !== null && !recorded) {
      this.ledger.append(row.obligationId, "FUNDING_BALANCES", {
        fundingId: row.id,
        conversionId: row.conversionId,
        wallets: { [row.buyCurrency]: wallets[row.buyCurrency] ?? 0, [row.sellCurrency]: wallets[row.sellCurrency] ?? 0 },
      });
    }
    return { outcome, conversion: row, walletsAfter: wallets };
  }

  private result(outcome: FundingOutcome, row: ConversionAttempt): FundingResult {
    return { outcome, conversion: row, walletsAfter: null };
  }
}
