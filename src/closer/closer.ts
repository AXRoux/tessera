import type { FinancialTransaction, ReconciliationApi } from "../airwallex/types";
import { canonicalJson, sha256Hex } from "../canonical";
import { NotClosable } from "../errors";
import { NEVER_EXECUTED_STATUSES, type PayoutGateway } from "../gateway/gateway";
import type { ConversionAttempt } from "../ledger/conversions";
import { paidObservedAt } from "../ledger/events";
import type { Attempt, Ledger, Obligation } from "../ledger/ledger";
import { toMinor } from "../money";
import {
  SignedCertificateSchema,
  type CertificateFunding,
  type ClosureCertificateBody,
  type SignedCertificate,
  type Totals,
  type WalletLines,
} from "./certificate";
import { signCertificateHash } from "./signing";

/** A funding conversion as reconciled: what the ledger expects, what Airwallex booked, and anything that does not tie. */
export type FundingReconciliation = CertificateFunding & { problems: string[] };

export interface AttemptReconciliation {
  attemptId: string;
  seq: number;
  requestId: string;
  transferId: string | null;
  state: Attempt["state"];
  /** Airwallex's status for the transfer as of this reconciliation (synced first). */
  awxStatus: string | null;
  failureCode: string | null;
  expected: WalletLines | null;
  actual: WalletLines | null;
  problems: string[];
}

export interface Reconciliation {
  obligationId: string;
  reference: string;
  currency: string;
  amountMinor: number;
  closable: boolean;
  blockers: string[];
  attempts: AttemptReconciliation[];
  /** Conversions that funded a replacement for this invoice, each leg checked against Airwallex's wallet lines. */
  funding: FundingReconciliation[];
  totals: Totals;
  untrackedTransfers: string[];
  checkedAt: string;
  /** Identifies the ledger state this was computed from; `close` refuses if it moved underneath. */
  fingerprint: string;
}

export interface CloserConfig {
  ledger: Ledger;
  api: ReconciliationApi;
  /** Reconciliation starts from Airwallex's current transfer status, never from what the ledger last saw. */
  gateway: PayoutGateway;
  secret: string;
  now?: () => Date;
  /**
   * PAID is not final: banks can still return a paid transfer. The incident stays open this long after the transfer
   * was first seen PAID. 24h is a placeholder policy; sandbox demos pass a short window explicitly. Must be a finite
   * number >= 0: a NaN here would silently disable the hold.
   */
  paidHoldMs?: number;
}

const ZERO: WalletLines = { payoutMinor: 0, feeMinor: 0, reversalMinor: 0 };

/**
 * What Airwallex must have booked for an attempt that reached its state. A failed transfer keeps its fee. A transfer
 * that never executed (approval rejected, blocked or recalled, then released by a person) moved no money.
 */
function expectedLines(attempt: Attempt): WalletLines | null {
  const fee = attempt.feeMinor ?? 0;
  if (attempt.state === "PAID") return { payoutMinor: -attempt.amountMinor, feeMinor: -fee, reversalMinor: 0 };
  if (attempt.state === "DEAD" && attempt.awxStatus !== null && NEVER_EXECUTED_STATUSES.includes(attempt.awxStatus)) return ZERO;
  if (attempt.state === "DEAD") return { payoutMinor: -attempt.amountMinor, feeMinor: -fee, reversalMinor: attempt.amountMinor };
  if (attempt.state === "ABANDONED") return ZERO;
  return null;
}

/**
 * Sums one transfer's wallet lines. Tessera makes same-currency payouts only (source = transfer currency), so every
 * line must be in the obligation's currency; a line in any other currency is reported, never converted or summed.
 */
function sumLines(rows: FinancialTransaction[], currency: string): { lines: WalletLines; pending: number; unexpected: string[] } {
  const lines: WalletLines = { payoutMinor: 0, feeMinor: 0, reversalMinor: 0 };
  const unexpected: string[] = [];
  let pending = 0;
  for (const row of rows) {
    if (row.status !== "SETTLED") pending++;
    if (row.currency !== currency) {
      unexpected.push(`${row.transaction_type} ${row.net} ${row.currency} (not ${currency}; only same-currency payouts reconcile)`);
      continue;
    }
    const net = toMinor(row.net, row.currency);
    if (row.transaction_type === "PAYOUT") lines.payoutMinor += net;
    else if (row.transaction_type === "FEE") lines.feeMinor += net;
    else if (row.transaction_type === "PAYOUT_REVERSAL") lines.reversalMinor += net;
    else unexpected.push(`${row.transaction_type} ${row.net} ${row.currency}`);
  }
  return { lines, pending, unexpected };
}

/** The ledger state a reconciliation saw: obligation status, every attempt and every conversion. `close` refuses if any moved. */
const fingerprintOf = (obligation: Obligation, attempts: Attempt[], conversions: ConversionAttempt[]): string =>
  [
    `${obligation.status}:${obligation.updatedAt}`,
    ...attempts.map((a) => `${a.id}:${a.state}:${a.awxStatus}:${a.updatedAt}`),
    ...conversions.map((c) => `${c.id}:${c.state}:${c.awxStatus}:${c.updatedAt}`),
  ].join("|");

/**
 * What a conversion must have booked: the bought currency in, the sold currency out, nothing else. An ABANDONED one was
 * never booked; one still in flight or cancelled cannot be tied off by code, so a person looks.
 */
function fundingProblemsBeforeLines(row: ConversionAttempt): string | null {
  if (row.state === "INTENT" || row.state === "BOOKED") return `still ${row.state}; the conversion has not settled`;
  if (row.state === "CANCELLED") return "Airwallex cancelled it; a person must reconcile its wallet lines";
  return null;
}

export class Closer {
  private readonly ledger: Ledger;
  private readonly api: ReconciliationApi;
  private readonly gateway: PayoutGateway;
  private readonly secret: string;
  private readonly now: () => Date;
  private readonly paidHoldMs: number;

  constructor(config: CloserConfig) {
    const paidHoldMs = config.paidHoldMs ?? 24 * 3600_000;
    if (!Number.isFinite(paidHoldMs) || paidHoldMs < 0) {
      throw new Error(`paidHoldMs must be a finite number of milliseconds >= 0, got ${String(config.paidHoldMs)}`);
    }
    this.ledger = config.ledger;
    this.api = config.api;
    this.gateway = config.gateway;
    this.secret = config.secret;
    this.now = config.now ?? (() => new Date());
    this.paidHoldMs = paidHoldMs;
  }

  /**
   * Pulls every live or paid transfer's current status from Airwallex (through the gateway, so changes are
   * recorded), then compares the ledger's beliefs with the wallet lines Airwallex booked.
   */
  async reconcile(obligationId: string): Promise<Reconciliation> {
    await this.gateway.sync(obligationId);
    const obligation = this.ledger.requireObligation(obligationId);
    const attempts = this.ledger.attemptsFor(obligationId);
    const blockers: string[] = [];

    const reconciled: AttemptReconciliation[] = [];
    for (const attempt of attempts) reconciled.push(await this.reconcileAttempt(attempt, obligation.currency));
    for (const item of reconciled) for (const problem of item.problems) blockers.push(`attempt #${item.seq}: ${problem}`);

    const conversions = this.ledger.conversionsFor(obligationId);
    const funding: FundingReconciliation[] = [];
    for (const row of conversions) funding.push(await this.reconcileFunding(row));
    for (const item of funding) for (const problem of item.problems) blockers.push(`conversion ${item.conversionId ?? item.fundingId}: ${problem}`);

    const paid = attempts.filter((a) => a.state === "PAID");
    if (paid.length !== 1) blockers.push(`expected exactly one PAID attempt, found ${paid.length}`);
    else this.checkHoldWindow(paid[0]!, blockers);

    const totals = this.totals(reconciled);
    if (paid.length === 1 && totals.paidMinor !== obligation.amountMinor) {
      blockers.push(`the wallet shows ${totals.paidMinor} minor units left for the supplier, but ${obligation.amountMinor} are owed`);
    }

    const untracked = await this.findUntracked(obligation, attempts);
    for (const id of untracked) blockers.push(`transfer ${id} carries this reference but is not in the ledger`);

    if (obligation.status === "ESCALATED") blockers.push(`obligation is escalated: ${obligation.escalationReason}`);
    const chain = this.ledger.verifyChain();
    if (!chain.ok) blockers.push(`event chain is broken: ${chain.reason}`);

    return {
      obligationId,
      reference: obligation.reference,
      currency: obligation.currency,
      amountMinor: obligation.amountMinor,
      closable: blockers.length === 0,
      blockers,
      attempts: reconciled,
      funding,
      totals,
      untrackedTransfers: untracked,
      checkedAt: this.now().toISOString(),
      fingerprint: fingerprintOf(obligation, attempts, conversions),
    };
  }

  /**
   * Certifies the incident, or throws NotClosable with every reason. Closing twice (or two closes racing) returns
   * the one certificate that was stored.
   */
  async close(obligationId: string): Promise<SignedCertificate> {
    const stored = this.ledger.getCertificateJson(obligationId);
    if (stored) return SignedCertificateSchema.parse(JSON.parse(stored));

    const reconciliation = await this.reconcile(obligationId);
    if (!reconciliation.closable) throw new NotClosable(obligationId, reconciliation.blockers);

    return this.ledger.tx(() => {
      // Everything below is re-read inside the write transaction: another process may have closed, escalated or
      // synced while we were talking to Airwallex.
      const raced = this.ledger.getCertificateJson(obligationId);
      if (raced) return SignedCertificateSchema.parse(JSON.parse(raced));
      const obligation = this.ledger.requireObligation(obligationId);
      if (obligation.status === "ESCALATED") {
        throw new NotClosable(obligationId, [`obligation is escalated: ${obligation.escalationReason}`]);
      }
      const attempts = this.ledger.attemptsFor(obligationId);
      if (fingerprintOf(obligation, attempts, this.ledger.conversionsFor(obligationId)) !== reconciliation.fingerprint) {
        throw new NotClosable(obligationId, ["the ledger changed while reconciling; run it again"]);
      }
      const settled = attempts.find((a) => a.state === "PAID");
      if (!settled || settled.awxStatus !== "PAID" || settled.transferId === null) {
        throw new NotClosable(obligationId, ["Airwallex does not currently report the settled transfer as PAID"]);
      }
      const chain = this.ledger.verifyChain();
      if (!chain.ok) throw new NotClosable(obligationId, [`event chain is broken: ${chain.reason}`]);

      const body: ClosureCertificateBody = {
        version: 3,
        obligationId,
        reference: obligation.reference,
        currency: obligation.currency,
        amountMinor: obligation.amountMinor,
        beneficiaryId: settled.beneficiaryId,
        settledAttemptId: settled.id,
        settledTransferId: settled.transferId,
        settledAwxStatus: "PAID",
        attempts: reconciliation.attempts.map(({ seq, attemptId, requestId, transferId, state, awxStatus, failureCode, expected, actual }) => ({
          seq, attemptId, requestId, transferId, state, awxStatus, failureCode, expected, actual,
        })),
        totals: reconciliation.totals,
        funding: reconciliation.funding.map(({ problems: _problems, ...row }) => row),
        eventChainHead: chain.head,
        issuedAt: this.now().toISOString(),
      };
      const hash = sha256Hex(canonicalJson(body));
      const certificate: SignedCertificate = { body, hash, signature: signCertificateHash(hash, this.secret) };

      this.ledger.saveCertificate(obligationId, hash, JSON.stringify(certificate));
      this.ledger.setObligationStatus(obligationId, "CLOSED");
      this.ledger.append(obligationId, "CLOSED", { certificateHash: hash, settledTransferId: settled.transferId });
      return certificate;
    });
  }

  /** Both legs of a conversion against Airwallex's own wallet lines for it (`source_id` = the conversion id). */
  private async reconcileFunding(row: ConversionAttempt): Promise<FundingReconciliation> {
    const base: CertificateFunding = {
      fundingId: row.id, conversionId: row.conversionId, requestId: row.requestId, quoteId: row.quoteId, forAttemptId: row.forAttemptId,
      state: row.state, currencyPair: row.currencyPair, rate: row.rate, buyCurrency: row.buyCurrency, sellCurrency: row.sellCurrency,
      expected: row.state === "ABANDONED" ? { buyMinor: 0, sellMinor: 0 } : { buyMinor: row.buyMinor, sellMinor: -row.sellMinor },
      actual: null,
    };
    const early = fundingProblemsBeforeLines(row);
    if (early) return { ...base, problems: [early] };
    if (row.conversionId === null) {
      return { ...base, actual: { buyMinor: 0, sellMinor: 0 }, problems: row.state === "ABANDONED" ? [] : ["no conversion id recorded"] };
    }
    const problems: string[] = [];
    let buyMinor = 0;
    let sellMinor = 0;
    let pending = 0;
    for (const line of await this.api.listFinancialTransactions(row.conversionId)) {
      if (line.status !== "SETTLED") pending++;
      const net = toMinor(line.net, line.currency);
      if (line.transaction_type === "CONVERSION_BUY" && line.currency === row.buyCurrency) buyMinor += net;
      else if (line.transaction_type === "CONVERSION_SELL" && line.currency === row.sellCurrency) sellMinor += net;
      else problems.push(`unexpected wallet line ${line.transaction_type} ${line.net} ${line.currency}`);
    }
    if (pending > 0) problems.push(`${pending} wallet line(s) still pending`);
    if (buyMinor !== base.expected.buyMinor) problems.push(`bought ${buyMinor} minor ${row.buyCurrency} at Airwallex, the ledger expects ${base.expected.buyMinor}`);
    if (sellMinor !== base.expected.sellMinor) problems.push(`sold ${-sellMinor} minor ${row.sellCurrency} at Airwallex, the ledger expects ${-base.expected.sellMinor}`);
    return { ...base, actual: { buyMinor, sellMinor }, problems };
  }

  private async reconcileAttempt(attempt: Attempt, currency: string): Promise<AttemptReconciliation> {
    const expected = expectedLines(attempt);
    const problems: string[] = [];
    const base = {
      attemptId: attempt.id,
      seq: attempt.seq,
      requestId: attempt.requestId,
      transferId: attempt.transferId,
      state: attempt.state,
      awxStatus: attempt.awxStatus,
      failureCode: attempt.failureCode,
      expected,
    };

    if (expected === null) {
      problems.push(`still ${attempt.state}; not final`);
      return { ...base, actual: null, problems };
    }
    if (!attempt.transferId) {
      if (attempt.state !== "ABANDONED") problems.push("no transfer id recorded");
      return { ...base, actual: ZERO, problems };
    }

    const { lines, pending, unexpected } = sumLines(await this.api.listFinancialTransactions(attempt.transferId), currency);
    if (pending > 0) problems.push(`${pending} wallet line(s) still pending`);
    for (const line of unexpected) problems.push(`unexpected wallet line ${line}`);
    for (const key of ["payoutMinor", "feeMinor", "reversalMinor"] as const) {
      if (lines[key] !== expected[key]) problems.push(`${key} is ${lines[key]} at Airwallex, ledger expects ${expected[key]}`);
    }
    return { ...base, actual: lines, problems };
  }

  private checkHoldWindow(paid: Attempt, blockers: string[]): void {
    const paidAt = paidObservedAt(this.ledger.events(paid.obligationId), paid.id);
    if (!paidAt) {
      blockers.push(`no record of when attempt #${paid.seq} became PAID`);
      return;
    }
    const heldMs = this.now().getTime() - Date.parse(paidAt);
    if (heldMs < this.paidHoldMs) {
      const left = this.paidHoldMs - heldMs;
      const remaining = left < 120_000 ? `${Math.ceil(left / 1000)}s` : `${Math.ceil(left / 60_000)} min`;
      blockers.push(`PAID is not final: hold window has ${remaining} left (banks can still return a paid transfer)`);
    }
  }

  private totals(items: AttemptReconciliation[]): Totals {
    let payout = 0;
    let fee = 0;
    let reversal = 0;
    for (const item of items) {
      payout += item.actual?.payoutMinor ?? 0;
      fee += item.actual?.feeMinor ?? 0;
      reversal += item.actual?.reversalMinor ?? 0;
    }
    return { paidMinor: -(payout + reversal), feesMinor: -fee, refundedMinor: reversal, netWalletMinor: payout + fee + reversal };
  }

  /**
   * A transfer carrying our reference that the ledger never created: someone else paid this obligation. The API
   * pages the full list, so a duplicate on page two is found too.
   */
  private async findUntracked(obligation: Obligation, attempts: Attempt[]): Promise<string[]> {
    const known = new Set(attempts.map((a) => a.transferId).filter((id): id is string => id !== null));
    const since = new Date(Date.parse(obligation.createdAt) - 60_000).toISOString();
    const transfers = await this.api.listTransfers(since);
    return transfers.filter((t) => t.reference === obligation.reference && !known.has(t.id)).map((t) => t.id);
  }
}
