import { z } from "zod";
import {
  AwxHttpError,
  type CreateTransferRequest,
  type PayoutApi,
  type Transfer,
} from "../airwallex/types";
import { isWrittenNote, requireHumanNote, verifyApproval, type Approval, type ApprovalPayload } from "../approval/approval";
import { lookupFailure } from "../domain/playbook";
import {
  ApprovalRejected,
  DuplicateLockError,
  LedgerMismatchError,
  ObligationNotPayable,
  ReplacementDenied,
  StateConflict,
} from "../errors";
import { classifyStatus } from "../ledger/events";
import type { Attempt, AttemptPatch, AttemptState, Ledger } from "../ledger/ledger";
import { fromMinor, toMinor } from "../money";

export type SubmitOutcome =
  | "CREATED"
  | "ADOPTED_DUPLICATE"
  | "ADOPTED_AFTER_AMBIGUITY"
  | "PENDING_RECOVERY"
  | "REJECTED";

export interface SubmitResult {
  outcome: SubmitOutcome;
  attempt: Attempt;
}

export interface GatewayConfig {
  ledger: Ledger;
  api: PayoutApi;
  approvalSecret: string;
  now?: () => Date;
  newRequestId?: () => string;
  /** Airwallex dedupes request_ids for 7 days; stop re-sending long before that. */
  maxIntentAgeMs?: number;
  /** Waits between rate-limited resends of a create. Tests pass a recorder. */
  sleep?: (ms: number) => Promise<void>;
}

export interface ResolveAttemptInput {
  attemptId: string;
  /** The named person releasing the lock. */
  by: string;
  /** Why, in writing (the same rule as a human approval note). */
  note: string;
}

/** Airwallex's duplicate_request_id error names the transfer that already used the request_id. */
const DuplicateBodySchema = z.looseObject({ details: z.looseObject({ id: z.string() }) });
const AttemptRefSchema = z.looseObject({ attemptId: z.string() });

const KNOWN_STATUSES = [
  "SCHEDULED", "IN_APPROVAL", "APPROVAL_RECALLED", "APPROVAL_REJECTED", "APPROVAL_BLOCKED",
  "OVERDUE", "PROCESSING", "SENT", "PAID", "FAILED", "CANCELLED",
];

/** Statuses of a transfer that never left the account: a person may release its lock once Airwallex confirms it. */
export const NEVER_EXECUTED_STATUSES: readonly string[] = ["APPROVAL_REJECTED", "APPROVAL_BLOCKED", "APPROVAL_RECALLED"];

/** Resends of a rate-limited create (same request_id) before treating the outcome as ambiguous. */
const RATE_LIMIT_RETRIES = 3;
const MAX_RATE_LIMIT_WAIT_MS = 30_000;

/** Any 4xx other than 408/429 means Airwallex did not process the request. */
const isDefinitiveRejection = (error: AwxHttpError): boolean =>
  error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;

function changeSatisfied(change: "BENEFICIARY" | "REASON" | "METHOD" | undefined, prev: Attempt, p: ApprovalPayload): boolean {
  if (change === "BENEFICIARY") return p.beneficiaryId !== prev.beneficiaryId;
  if (change === "REASON") return p.reason !== prev.reason;
  if (change === "METHOD") return p.method !== prev.method;
  return false;
}

function checkReplacement(prev: Attempt, p: ApprovalPayload): void {
  const entry = lookupFailure(prev.failureCode);
  const humanVouches = p.mode === "HUMAN" && isWrittenNote(p.note);
  if (entry.replace === "AUTO") return;
  if (entry.replace === "AFTER_CHANGE" && (humanVouches || changeSatisfied(entry.change, prev, p))) return;
  if (entry.replace === "FORBIDDEN" && humanVouches) return;
  throw new ReplacementDenied(
    prev.failureCode,
    entry.replace,
    entry.replace === "AFTER_CHANGE"
      ? `${entry.guidance} Needs a changed ${entry.change?.toLowerCase()} or a human approval with a written note.`
      : `${entry.guidance} Needs a human approval with a written note.`,
  );
}

export class PayoutGateway {
  private readonly ledger: Ledger;
  private readonly api: PayoutApi;
  private readonly secret: string;
  private readonly now: () => Date;
  private readonly newRequestId: () => string;
  private readonly maxIntentAgeMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(config: GatewayConfig) {
    if (config.approvalSecret.length < 32) throw new Error("approval secret must be at least 32 characters");
    this.ledger = config.ledger;
    this.api = config.api;
    this.secret = config.approvalSecret;
    this.now = config.now ?? (() => new Date());
    this.newRequestId = config.newRequestId ?? (() => crypto.randomUUID());
    this.maxIntentAgeMs = config.maxIntentAgeMs ?? 24 * 3600_000;
    this.sleep = config.sleep ?? ((ms) => Bun.sleep(ms));
  }

  /**
   * Pays an obligation exactly once. The intent (with its request_id) is committed before the network call, so a
   * crash at any later point is resolved by looking the request_id up, never by minting a new one.
   */
  async submit(approval: Approval): Promise<SubmitResult> {
    const payload = verifyApproval(approval, this.secret, this.now());
    return this.execute(this.begin(payload));
  }

  /**
   * Resolves attempts left in INTENT by a crash or outage, for one obligation or all of them. Safe to run repeatedly:
   * an intent too old to re-send is looked up only, and escalated to a person once (not on every run).
   */
  async recover(obligationId?: string): Promise<SubmitResult[]> {
    const results: SubmitResult[] = [];
    for (const attempt of this.ledger.intentAttempts(obligationId)) {
      const age = this.now().getTime() - Date.parse(attempt.createdAt);
      let found: Transfer | null = null;
      try {
        found = await this.api.findTransferByRequestId(attempt.requestId);
      } catch (error) {
        this.ledger.updateAttempt(attempt.id, { lastError: String(error) });
        results.push({ outcome: "PENDING_RECOVERY", attempt: this.ledger.requireAttempt(attempt.id) });
        continue;
      }
      if (found) {
        results.push({ outcome: "ADOPTED_AFTER_AMBIGUITY", attempt: this.adopt(attempt, this.checked(attempt, found), "recover_lookup") });
      } else if (age > this.maxIntentAgeMs) {
        // Cannot prove the transfer does not exist, so the lock stays and a person decides (resolveAttempt).
        this.escalateStaleIntent(attempt, age);
        results.push({ outcome: "PENDING_RECOVERY", attempt: this.ledger.requireAttempt(attempt.id) });
      } else {
        results.push(await this.execute(attempt));
      }
    }
    return results;
  }

  /** Pulls the latest transfer state for every live or paid attempt. */
  async sync(obligationId?: string): Promise<Attempt[]> {
    const updated: Attempt[] = [];
    for (const attempt of this.ledger.syncableAttempts(obligationId)) {
      const transfer = this.checked(attempt, await this.api.getTransfer(attempt.transferId!));
      updated.push(this.adopt(attempt, transfer, "sync"));
    }
    return updated;
  }

  /**
   * A webhook is only a hint: the transfer is re-read from Airwallex and adopted like any sync. A transfer the
   * ledger never created (by transfer id or request_id) returns null and changes nothing.
   */
  async syncTransfer(transferId: string): Promise<Attempt | null> {
    const known = this.ledger.attemptByTransferId(transferId);
    let transfer: Transfer;
    try {
      transfer = await this.api.getTransfer(transferId);
    } catch (error) {
      if (!known && error instanceof AwxHttpError && error.status === 404) return null;
      throw error;
    }
    const attempt = known ?? (transfer.request_id ? this.ledger.attemptByRequestId(transfer.request_id) : null);
    if (!attempt || attempt.state === "ABANDONED") return null;
    return this.adopt(attempt, this.checked(attempt, transfer), "webhook");
  }

  /**
   * Human-only release of a lock, after re-verifying at Airwallex. An INTENT Airwallex has no transfer for becomes
   * ABANDONED; a CANCELLED transfer, or one that was never executed (approval rejected, blocked or recalled), becomes
   * DEAD. Anything else is a live transfer whose lock cannot be released, and this throws.
   */
  async resolveAttempt(input: ResolveAttemptInput): Promise<Attempt> {
    requireHumanNote(input.by, input.note);
    const attempt = this.ledger.requireAttempt(input.attemptId);
    this.requireVerifiedLedger(attempt.obligationId);
    let to: AttemptState;
    if (attempt.state === "INTENT") {
      const found = await this.api.findTransferByRequestId(attempt.requestId);
      if (found) {
        const adopted = this.adopt(attempt, this.checked(attempt, found), "resolve_lookup");
        throw new StateConflict(`Airwallex holds transfer ${found.id} (${found.status}) for this request_id; it is now attempt state ${adopted.state}, not released`);
      }
      to = "ABANDONED";
    } else if (attempt.state === "LIVE" || attempt.state === "PAID") {
      const transfer = this.checked(attempt, await this.api.getTransfer(attempt.transferId!));
      this.adopt(attempt, transfer, "resolve_lookup");
      if (transfer.status !== "CANCELLED" && !NEVER_EXECUTED_STATUSES.includes(transfer.status)) {
        throw new StateConflict(`transfer ${transfer.id} is ${transfer.status} at Airwallex; a live transfer's lock cannot be released`);
      }
      to = "DEAD";
    } else {
      throw new StateConflict(`attempt ${attempt.id} is already ${attempt.state}; there is no lock to release`);
    }

    return this.ledger.tx(() => {
      this.requireVerifiedLedger(attempt.obligationId);
      const current = this.ledger.requireAttempt(attempt.id);
      const from = attempt.state;
      if (current.state !== from && current.state !== to) {
        throw new StateConflict(`attempt ${attempt.id} moved to ${current.state} while it was being verified; check it again`);
      }
      const updated = this.ledger.updateAttempt(current.id, { state: to });
      this.ledger.append(current.obligationId, "ATTEMPT_RESOLVED", { attemptId: current.id, by: input.by, note: input.note, from, to });
      this.ledger.refreshObligationStatus(current.obligationId);
      return updated;
    });
  }

  // ---- phase 1: durable intent ------------------------------------------------

  /**
   * Nothing moves money or releases a lock on a ledger that does not verify: an attempt row edited to DEAD would
   * otherwise free the lock for a second payment.
   */
  private requireVerifiedLedger(obligationId: string): void {
    const chain = this.ledger.verifyChain();
    if (!chain.ok) throw new ObligationNotPayable(obligationId, `ledger does not verify (${chain.reason}); a person must investigate`);
  }

  private begin(p: ApprovalPayload): Attempt {
    return this.ledger.tx(() => {
      this.requireVerifiedLedger(p.obligationId);
      const obligation = this.ledger.getObligation(p.obligationId);
      if (!obligation) throw new ObligationNotPayable(p.obligationId, "unknown obligation");
      if (obligation.status === "CLOSED") throw new ObligationNotPayable(obligation.id, "obligation is closed");
      if (obligation.status === "ESCALATED" && p.mode !== "HUMAN") {
        throw new ObligationNotPayable(obligation.id, `escalated (${obligation.escalationReason}); human approval required`);
      }
      if (this.ledger.nonceUsed(p.nonce)) throw new ApprovalRejected("replayed", "approval nonce already used");
      if (p.amountMinor !== obligation.amountMinor || p.currency !== obligation.currency) {
        throw new ApprovalRejected("terms_mismatch", "approval amount/currency differs from the obligation");
      }

      const attempts = this.ledger.attemptsFor(obligation.id);
      const latest = attempts.at(-1) ?? null;
      if (latest && (latest.state === "INTENT" || latest.state === "LIVE" || latest.state === "PAID")) {
        throw new DuplicateLockError(obligation.id);
      }
      if ((latest?.id ?? null) !== p.replacesAttemptId) {
        throw new ApprovalRejected("stale", `approval replaces ${p.replacesAttemptId}, latest attempt is ${latest?.id ?? "none"}`);
      }

      // An ABANDONED attempt never reached Airwallex, so it neither counts as a first payment nor resets the playbook:
      // the rules are those of the latest attempt that really existed.
      const settled = attempts.findLast((a) => a.state !== "ABANDONED") ?? null;
      if (!settled) {
        if (p.beneficiaryId !== obligation.beneficiaryId || p.method !== obligation.method || p.reason !== obligation.reason) {
          throw new ApprovalRejected("terms_mismatch", "first attempt must use the obligation's own terms");
        }
      } else if (settled.state === "DEAD") {
        checkReplacement(settled, p);
      }

      const attempt = this.ledger.insertAttempt({
        obligationId: obligation.id,
        seq: (latest?.seq ?? 0) + 1,
        requestId: this.newRequestId(),
        beneficiaryId: p.beneficiaryId,
        amountMinor: p.amountMinor,
        currency: p.currency,
        method: p.method,
        reason: p.reason,
        approvalNonce: p.nonce,
      });
      this.ledger.setObligationTerms(obligation.id, { beneficiaryId: p.beneficiaryId, method: p.method, reason: p.reason });
      this.ledger.setObligationStatus(obligation.id, "PAYING");
      this.ledger.append(obligation.id, "ATTEMPT_INTENT", {
        attemptId: attempt.id,
        seq: attempt.seq,
        requestId: attempt.requestId,
        replaces: latest?.id ?? null,
        replacesFailureCode: settled?.failureCode ?? null,
        mode: p.mode,
        approver: p.approver,
        note: p.note ?? null,
        evidenceHash: p.evidenceHash,
        nonce: p.nonce,
        terms: { beneficiaryId: p.beneficiaryId, amountMinor: p.amountMinor, currency: p.currency, method: p.method, reason: p.reason },
      });
      return attempt;
    });
  }

  // ---- phase 2: network -------------------------------------------------------

  private async execute(attempt: Attempt): Promise<SubmitResult> {
    const obligation = this.ledger.requireObligation(attempt.obligationId);
    // Same-currency payouts only: the wallet pays in the currency it owes, and the Closer refuses anything else.
    const request: CreateTransferRequest = {
      request_id: attempt.requestId,
      beneficiary_id: attempt.beneficiaryId,
      source_currency: attempt.currency,
      transfer_currency: attempt.currency,
      transfer_amount: fromMinor(attempt.amountMinor, attempt.currency),
      transfer_method: attempt.method,
      reason: attempt.reason,
      reference: obligation.reference,
    };

    try {
      const transfer = await this.create(request);
      return { outcome: "CREATED", attempt: this.adopt(attempt, this.checked(attempt, transfer), "create") };
    } catch (error) {
      if (error instanceof LedgerMismatchError) throw error;
      if (error instanceof AwxHttpError) {
        if (error.code === "duplicate_request_id") {
          const existing = await this.resolveDuplicate(attempt, error);
          if (existing) return { outcome: "ADOPTED_DUPLICATE", attempt: this.adopt(attempt, this.checked(attempt, existing), "duplicate_request_id") };
        } else if (isDefinitiveRejection(error)) {
          return { outcome: "REJECTED", attempt: this.abandon(attempt, error.message) };
        }
      }
      return this.resolveAmbiguity(attempt, error);
    }
  }

  /** A 429 was not processed: resend the same request_id after the wait Airwallex asked for, a few times at most. */
  private async create(request: CreateTransferRequest): Promise<Transfer> {
    for (let retry = 0; ; retry++) {
      try {
        return await this.api.createTransfer(request);
      } catch (error) {
        if (!(error instanceof AwxHttpError) || error.status !== 429 || retry >= RATE_LIMIT_RETRIES) throw error;
        await this.sleep(Math.min(error.retryAfterMs ?? 1_000 * 2 ** retry, MAX_RATE_LIMIT_WAIT_MS));
      }
    }
  }

  private async resolveDuplicate(attempt: Attempt, error: AwxHttpError): Promise<Transfer | null> {
    const parsed = DuplicateBodySchema.safeParse(error.body);
    const id = parsed.success ? parsed.data.details.id : undefined;
    try {
      return typeof id === "string" ? await this.api.getTransfer(id) : await this.api.findTransferByRequestId(attempt.requestId);
    } catch {
      return null;
    }
  }

  /** The create may or may not have reached Airwallex. Look it up by the same request_id; never mint another. */
  private async resolveAmbiguity(attempt: Attempt, cause: unknown): Promise<SubmitResult> {
    const message = cause instanceof Error ? cause.message : String(cause);
    this.ledger.tx(() => {
      this.ledger.updateAttempt(attempt.id, { lastError: message });
      this.ledger.append(attempt.obligationId, "CREATE_AMBIGUOUS", { attemptId: attempt.id, error: message });
    });
    try {
      const found = await this.api.findTransferByRequestId(attempt.requestId);
      if (found) {
        return { outcome: "ADOPTED_AFTER_AMBIGUITY", attempt: this.adopt(attempt, this.checked(attempt, found), "ambiguity_lookup") };
      }
    } catch (lookupError) {
      if (lookupError instanceof LedgerMismatchError) throw lookupError;
    }
    return { outcome: "PENDING_RECOVERY", attempt: this.ledger.requireAttempt(attempt.id) };
  }

  /** Escalates an intent too old to re-send, once per attempt: later runs see the INTENT_STALE event and stay quiet. */
  private escalateStaleIntent(attempt: Attempt, ageMs: number): void {
    this.ledger.tx(() => {
      const already = this.ledger
        .events(attempt.obligationId)
        .some((e) => e.type === "INTENT_STALE" && AttemptRefSchema.safeParse(e.payload).data?.attemptId === attempt.id);
      if (already) return;
      const hours = Math.round(ageMs / 3600_000);
      this.ledger.append(attempt.obligationId, "INTENT_STALE", { attemptId: attempt.id, requestId: attempt.requestId, ageHours: hours });
      this.ledger.escalate(
        attempt.obligationId,
        `attempt ${attempt.id} unresolved for ${hours}h and Airwallex has no transfer for its request_id; a person must release it`,
      );
    });
  }

  // ---- state transitions -------------------------------------------------------

  /** A transfer sharing our request_id but not our terms is never adopted: the lock holds and a person looks. */
  private checked(attempt: Attempt, transfer: Transfer): Transfer {
    const matches =
      transfer.beneficiary_id === attempt.beneficiaryId &&
      transfer.transfer_currency === attempt.currency &&
      toMinor(transfer.transfer_amount, transfer.transfer_currency) === attempt.amountMinor &&
      (transfer.request_id === undefined || transfer.request_id === attempt.requestId);
    if (matches) return transfer;

    const detail = `airwallex transfer ${transfer.id} (${transfer.transfer_amount} ${transfer.transfer_currency} to ${transfer.beneficiary_id}) does not match intent`;
    this.ledger.tx(() => {
      this.ledger.updateAttempt(attempt.id, { lastError: detail });
      this.ledger.append(attempt.obligationId, "TRANSFER_MISMATCH", { attemptId: attempt.id, transferId: transfer.id, detail });
      this.ledger.escalate(attempt.obligationId, detail);
    });
    throw new LedgerMismatchError(attempt.id, detail);
  }

  private adopt(attempt: Attempt, transfer: Transfer, via: string): Attempt {
    return this.ledger.tx(() => {
      const current = this.ledger.requireAttempt(attempt.id);
      if (current.state === "DEAD") {
        if (transfer.status !== "CANCELLED" && transfer.status !== current.awxStatus) {
          this.ledger.append(current.obligationId, "STATUS_AFTER_DEAD", { attemptId: current.id, transferId: transfer.id, status: transfer.status });
        }
        return current;
      }
      // Overlapping syncs: a snapshot older than the one already applied must not roll the status back.
      const stale = transfer.updated_at !== undefined && current.awxUpdatedAt !== null &&
        Date.parse(transfer.updated_at) < Date.parse(current.awxUpdatedAt);
      if (stale) return current;

      const next = classifyStatus(transfer.status);
      const changed = current.awxStatus !== transfer.status;
      const feeCurrency = transfer.fee_currency ?? transfer.transfer_currency;
      const payerCurrency = transfer.source_currency ?? transfer.transfer_currency;
      const patch: AttemptPatch = {
        state: next,
        transferId: transfer.id,
        awxStatus: transfer.status,
        awxUpdatedAt: transfer.updated_at,
        failureCode: transfer.failure?.code ?? current.failureCode ?? undefined,
        failureMessage: transfer.failure?.message ?? current.failureMessage ?? undefined,
        feeMinor: toMinor(transfer.fee_amount, feeCurrency),
        payerPaysMinor: transfer.amount_payer_pays === undefined ? undefined : toMinor(transfer.amount_payer_pays, payerCurrency),
        lastError: null,
      };
      // A poll that saw nothing new writes nothing, so the row (and the Closer's fingerprint of it) stays put.
      const keys = Object.keys(patch) as Array<keyof AttemptPatch>;
      if (!keys.some((key) => patch[key] !== undefined && patch[key] !== current[key])) return current;
      const updated = this.ledger.updateAttempt(current.id, patch);

      if (changed) {
        this.ledger.append(current.obligationId, "TRANSFER_STATUS", {
          attemptId: current.id,
          transferId: transfer.id,
          from: current.awxStatus,
          to: transfer.status,
          via,
          failureCode: transfer.failure?.code ?? null,
        });
        if (!KNOWN_STATUSES.includes(transfer.status)) {
          this.ledger.append(current.obligationId, "UNKNOWN_STATUS", { attemptId: current.id, status: transfer.status });
        }
      }
      if (current.state === "PAID" && next !== "PAID") {
        this.ledger.append(current.obligationId, "LATE_FAILURE", {
          attemptId: current.id,
          transferId: transfer.id,
          status: transfer.status,
          failureCode: transfer.failure?.code ?? null,
        });
        // A certificate that says "paid" is no longer true: withdraw it and hand the incident to a person.
        if (this.ledger.getCertificateJson(current.obligationId)) {
          this.ledger.revokeCertificate(
            current.obligationId,
            `certified payment failed late: transfer ${transfer.id} moved from PAID to ${transfer.status}`,
          );
        }
      }
      this.ledger.refreshObligationStatus(current.obligationId);
      return updated;
    });
  }

  private abandon(attempt: Attempt, reason: string): Attempt {
    return this.ledger.tx(() => {
      const updated = this.ledger.updateAttempt(attempt.id, { state: "ABANDONED", lastError: reason });
      this.ledger.append(attempt.obligationId, "ATTEMPT_ABANDONED", { attemptId: attempt.id, reason });
      this.ledger.refreshObligationStatus(attempt.obligationId);
      return updated;
    });
  }
}
