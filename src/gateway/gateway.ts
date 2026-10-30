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
  /**
   * How old an INTENT must be before a person may release it without Airwallex having a transfer for it. A create
   * can still be in flight (a sleeping 429 resend, a POST that timed out on our side but not theirs), and Airwallex
   * dedupes the request_id for days, so a young intent proves nothing. An INTENT already marked stale is exempt.
   */
  minIntentReleaseAgeMs?: number;
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
const AmbiguousPayloadSchema = z.looseObject({ attemptId: z.string(), error: z.string() });
const TransferRefSchema = z.looseObject({ attemptId: z.string(), transferId: z.string() });
const StatusAfterDeadSchema = z.looseObject({ transferId: z.string(), status: z.string() });

const KNOWN_STATUSES = [
  "SCHEDULED", "IN_APPROVAL", "APPROVAL_RECALLED", "APPROVAL_REJECTED", "APPROVAL_BLOCKED",
  "OVERDUE", "PROCESSING", "SENT", "PAID", "FAILED", "CANCELLED",
];

/**
 * Order of the statuses Airwallex moves a transfer through. Its `updated_at` has whole-second resolution, so two
 * snapshots can carry the same stamp; when they do, the one further along wins.
 */
const STATUS_RANK: Record<string, number> = { SCHEDULED: 0, PROCESSING: 1, SENT: 2, PAID: 3, FAILED: 4, CANCELLED: 5 };

/**
 * Statuses of a transfer held in an approval workflow. Airwallex documents each of them as resumable
 * (-> IN_APPROVAL: the transfer can be edited and resubmitted), so only CANCELLED proves it will never pay.
 */
export const NEVER_EXECUTED_STATUSES: readonly string[] = ["APPROVAL_REJECTED", "APPROVAL_BLOCKED", "APPROVAL_RECALLED"];

/** Resends of a rate-limited create (same request_id) before treating the outcome as ambiguous. */
const RATE_LIMIT_RETRIES = 3;
const MAX_RATE_LIMIT_WAIT_MS = 30_000;
/** A Retry-After of 0 (or none) must not become an immediate hammering: wait at least this, doubling per resend. */
const MIN_RATE_LIMIT_BACKOFF_MS = 250;
const DEFAULT_MIN_INTENT_RELEASE_AGE_MS = 10 * 60_000;
/** Lookups reach back this far before the intent was written, to cover clock skew with Airwallex. */
const LOOKUP_LEAD_MS = 3600_000;

/** Any 4xx other than 408/429 means Airwallex did not process the request. */
const isDefinitiveRejection = (error: AwxHttpError): boolean =>
  error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;

/** Where an execute comes from: a first send right after approval, or a re-send of an intent left behind. */
type SendOrigin = "submit" | "recover";

/** Raised just before a network send when the attempt may no longer be sent. */
class SendRefused extends Error {
  constructor(readonly why: "not_intent" | "escalated", readonly attempt: Attempt) {
    super(why === "escalated" ? `obligation is escalated; attempt ${attempt.id} is not sent` : `attempt ${attempt.id} is ${attempt.state}, not an open intent`);
    this.name = "SendRefused";
  }
}

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
  private readonly minIntentReleaseAgeMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(config: GatewayConfig) {
    if (config.approvalSecret.length < 32) throw new Error("approval secret must be at least 32 characters");
    this.ledger = config.ledger;
    this.api = config.api;
    this.secret = config.approvalSecret;
    this.now = config.now ?? (() => new Date());
    this.newRequestId = config.newRequestId ?? (() => crypto.randomUUID());
    this.maxIntentAgeMs = config.maxIntentAgeMs ?? 24 * 3600_000;
    this.minIntentReleaseAgeMs = config.minIntentReleaseAgeMs ?? DEFAULT_MIN_INTENT_RELEASE_AGE_MS;
    this.sleep = config.sleep ?? ((ms) => Bun.sleep(ms));
  }

  /**
   * Pays an obligation exactly once. The intent (with its request_id) is committed before the network call, so a
   * crash at any later point is resolved by looking the request_id up, never by minting a new one.
   */
  async submit(approval: Approval): Promise<SubmitResult> {
    const payload = verifyApproval(approval, this.secret, this.now());
    return this.execute(this.begin(payload), "submit");
  }

  /**
   * Resolves attempts left in INTENT by a crash or outage, for one obligation or all of them. Safe to run repeatedly:
   * an intent too old to re-send is looked up only, and escalated to a person once (not on every run). An attempt
   * that cannot be resolved (a mismatching transfer, an unreadable answer) never stops the ones after it; the first
   * unexpected failure is rethrown once they have all been tried. An escalated obligation is looked up, never sent.
   */
  async recover(obligationId?: string): Promise<SubmitResult[]> {
    const results: SubmitResult[] = [];
    let failure: unknown = null;
    for (const attempt of this.ledger.intentAttempts(obligationId)) {
      try {
        results.push(await this.recoverOne(attempt));
      } catch (error) {
        // A mismatch is already on the record and escalated; a release race is no failure.
        if (!(error instanceof LedgerMismatchError) && !(error instanceof StateConflict)) failure ??= error;
        results.push({ outcome: "PENDING_RECOVERY", attempt: this.ledger.requireAttempt(attempt.id) });
      }
    }
    if (failure !== null) throw failure;
    return results;
  }

  private async recoverOne(attempt: Attempt): Promise<SubmitResult> {
    const age = this.now().getTime() - Date.parse(attempt.createdAt);
    let found: Transfer | null = null;
    try {
      found = await this.lookup(attempt);
    } catch (error) {
      this.noteError(attempt, String(error));
      return { outcome: "PENDING_RECOVERY", attempt: this.ledger.requireAttempt(attempt.id) };
    }
    if (found) return { outcome: "ADOPTED_AFTER_AMBIGUITY", attempt: this.adopt(attempt, this.checked(attempt, found), "recover_lookup") };
    if (age > this.maxIntentAgeMs) {
      // Cannot prove the transfer does not exist, so the lock stays and a person decides (resolveAttempt).
      this.escalateStaleIntent(attempt, age);
      return { outcome: "PENDING_RECOVERY", attempt: this.ledger.requireAttempt(attempt.id) };
    }
    return this.execute(attempt, "recover");
  }

  /**
   * Pulls the latest transfer state for every live or paid attempt. One attempt that cannot be read never starves the
   * others: a mismatching transfer is already escalated and skipped, any other failure is rethrown after the rest.
   */
  async sync(obligationId?: string): Promise<Attempt[]> {
    const updated: Attempt[] = [];
    let failure: unknown = null;
    for (const attempt of this.ledger.syncableAttempts(obligationId)) {
      try {
        const transfer = this.checked(attempt, await this.api.getTransfer(attempt.transferId!));
        updated.push(this.adopt(attempt, transfer, "sync"));
      } catch (error) {
        if (!(error instanceof LedgerMismatchError)) failure ??= error;
      }
    }
    if (failure !== null) throw failure;
    return updated;
  }

  /**
   * A webhook is only a hint: the transfer is re-read from Airwallex and adopted like any sync. A transfer the
   * ledger never created (by transfer id or request_id) returns null and changes nothing. A transfer that belongs
   * to an ABANDONED attempt is recorded as an orphan and escalated (see `adopt`).
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
    if (!attempt) return null;
    return this.adopt(attempt, this.checked(attempt, transfer), "webhook");
  }

  /**
   * Human-only release of a lock, after re-verifying at Airwallex.
   *
   * - INTENT: released (ABANDONED) only if Airwallex has no transfer for its request_id AND the intent is old enough
   *   that no send can still be in flight (or it is already marked stale). A transfer Airwallex does hold is adopted
   *   instead and the release refused; one that does not match the intent is released but recorded as an orphan and
   *   escalated, because a person must decide what it is.
   * - LIVE/PAID: released (DEAD) only once Airwallex shows CANCELLED. Approval states (rejected, blocked, recalled)
   *   do not count: Airwallex lets a user resubmit them, so they can still pay.
   */
  async resolveAttempt(input: ResolveAttemptInput): Promise<Attempt> {
    requireHumanNote(input.by, input.note);
    const attempt = this.ledger.requireAttempt(input.attemptId);
    this.requireVerifiedLedger(attempt.obligationId);
    let to: AttemptState;
    let confirmedStatus: string | null = null;
    let orphan: Transfer | null = null;
    if (attempt.state === "INTENT") {
      const found = await this.lookup(attempt);
      if (found) {
        try {
          const adopted = this.adopt(attempt, this.checked(attempt, found), "resolve_lookup");
          throw new StateConflict(`Airwallex holds transfer ${found.id} (${found.status}) for this request_id; it is now attempt state ${adopted.state}, not released`);
        } catch (error) {
          if (!(error instanceof LedgerMismatchError)) throw error;
          orphan = found;
        }
      } else {
        this.requireReleasableAge(attempt);
      }
      to = "ABANDONED";
    } else if (attempt.state === "LIVE" || attempt.state === "PAID") {
      const transfer = this.checked(attempt, await this.api.getTransfer(attempt.transferId!));
      this.adopt(attempt, transfer, "resolve_lookup");
      if (transfer.status !== "CANCELLED") {
        throw new StateConflict(
          NEVER_EXECUTED_STATUSES.includes(transfer.status)
            ? `transfer ${transfer.id} is ${transfer.status} at Airwallex. Airwallex lets such a transfer be edited and resubmitted, so it can still be paid: its lock holds until Airwallex shows it CANCELLED. Cancel it there; the lock is released on the next sync.`
            : `transfer ${transfer.id} is ${transfer.status} at Airwallex; a live transfer's lock cannot be released`,
        );
      }
      confirmedStatus = transfer.status;
      to = "DEAD";
    } else {
      throw new StateConflict(`attempt ${attempt.id} is already ${attempt.state}; there is no lock to release`);
    }

    return this.ledger.tx(() => {
      this.requireVerifiedLedger(attempt.obligationId);
      const current = this.ledger.requireAttempt(attempt.id);
      const from = attempt.state;
      let updated: Attempt;
      if (to === "ABANDONED") {
        const released = this.ledger.abandonIntent(current.id);
        if (!released) throw new StateConflict(`attempt ${attempt.id} moved to ${current.state} while it was being verified; check it again`);
        updated = released;
      } else {
        if (current.state !== from && current.state !== to) {
          throw new StateConflict(`attempt ${attempt.id} moved to ${current.state} while it was being verified; check it again`);
        }
        if (current.awxStatus !== confirmedStatus) {
          throw new StateConflict(`attempt ${attempt.id} is ${current.awxStatus} at Airwallex, not ${confirmedStatus} as verified; check it again`);
        }
        updated = this.ledger.updateAttempt(current.id, { state: to });
      }
      this.ledger.append(current.obligationId, "ATTEMPT_RESOLVED", { attemptId: current.id, by: input.by, note: input.note, from, to });
      this.ledger.refreshObligationStatus(current.obligationId);
      if (orphan) this.recordOrphan(updated, orphan, "resolve_lookup");
      return this.ledger.requireAttempt(updated.id);
    });
  }

  /** An INTENT proves nothing about Airwallex until any send that was in flight for it has surely ended. */
  private requireReleasableAge(attempt: Attempt): void {
    const ageMs = this.now().getTime() - Date.parse(attempt.createdAt);
    if (ageMs >= this.minIntentReleaseAgeMs) return;
    const marked = this.ledger
      .events(attempt.obligationId)
      .some((e) => e.type === "INTENT_STALE" && AttemptRefSchema.safeParse(e.payload).data?.attemptId === attempt.id);
    if (marked) return;
    throw new StateConflict(
      `attempt ${attempt.id} is only ${Math.floor(ageMs / 60_000)} minute(s) old and Airwallex has no transfer for it yet, but its create may still be in flight (Airwallex honours a request_id for days). Release it once it is ${Math.ceil(this.minIntentReleaseAgeMs / 60_000)} minutes old.`,
    );
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
        const termsChanged = p.beneficiaryId !== obligation.beneficiaryId || p.method !== obligation.method || p.reason !== obligation.reason;
        // Airwallex refused every earlier request outright ("Correct the terms and try again"): a named person who
        // writes down why may correct the beneficiary, method or reason. A policy approval never may.
        const personCorrects = attempts.length > 0 && p.mode === "HUMAN" && isWrittenNote(p.note);
        if (termsChanged && !personCorrects) {
          throw new ApprovalRejected(
            "terms_mismatch",
            attempts.length > 0
              ? "the terms differ from the obligation's; only a named person with a written note may correct them"
              : "first attempt must use the obligation's own terms",
          );
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
        // This build records every failure code in a FAILURE_RECORDED event, so `verifyChain` can check the column.
        failuresRecorded: true,
      });
      return attempt;
    });
  }

  // ---- phase 2: network -------------------------------------------------------

  private async execute(attempt: Attempt, origin: SendOrigin): Promise<SubmitResult> {
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
      const transfer = await this.create(attempt, request);
      return { outcome: "CREATED", attempt: this.adoptSent(attempt, this.checked(attempt, transfer), "create") };
    } catch (error) {
      if (error instanceof SendRefused) return this.refusedSend(error);
      if (error instanceof LedgerMismatchError || error instanceof StateConflict) throw error;
      if (error instanceof AwxHttpError) {
        if (error.code === "duplicate_request_id") {
          const existing = await this.resolveDuplicate(attempt, error);
          if (existing) return { outcome: "ADOPTED_DUPLICATE", attempt: this.adoptSent(attempt, this.checked(attempt, existing), "duplicate_request_id") };
        } else if (isDefinitiveRejection(error) && origin === "submit") {
          // Only a first send is trusted to be "not processed". A re-send may answer 4xx for a transfer an earlier,
          // lost send already created, so on the recover path a 4xx is an ambiguity to look up.
          return this.abandon(attempt, error.message);
        }
      }
      return this.resolveAmbiguity(attempt, error);
    }
  }

  /**
   * Before every send (the first, and each resend after a 429 sleep) the attempt is re-read inside a transaction. A
   * person may have released the intent while this send slept, an obligation may have been escalated, and another
   * process may have adopted it: none of those may be followed by a POST.
   */
  private guardSend(attempt: Attempt): void {
    this.ledger.tx(() => {
      const current = this.ledger.requireAttempt(attempt.id);
      if (current.state !== "INTENT") throw new SendRefused("not_intent", current);
      if (this.ledger.requireObligation(current.obligationId).status === "ESCALATED") throw new SendRefused("escalated", current);
    });
  }

  private async refusedSend(refusal: SendRefused): Promise<SubmitResult> {
    if (refusal.why === "escalated") return this.lookupOnly(refusal.attempt);
    const current = this.ledger.requireAttempt(refusal.attempt.id);
    if (current.state === "ABANDONED") {
      throw new StateConflict(`attempt ${current.id} was released while its create was waiting to be sent; nothing was sent`);
    }
    return { outcome: "ADOPTED_AFTER_AMBIGUITY", attempt: current };
  }

  /** An escalated obligation is never sent for: look the request_id up and adopt what is there, nothing more. */
  private async lookupOnly(attempt: Attempt): Promise<SubmitResult> {
    try {
      const found = await this.lookup(attempt);
      if (found) return { outcome: "ADOPTED_AFTER_AMBIGUITY", attempt: this.adopt(attempt, this.checked(attempt, found), "escalated_lookup") };
    } catch (error) {
      if (error instanceof LedgerMismatchError) throw error;
      this.noteError(attempt, String(error));
    }
    return { outcome: "PENDING_RECOVERY", attempt: this.ledger.requireAttempt(attempt.id) };
  }

  /** A 429 was not processed: resend the same request_id after the wait Airwallex asked for, a few times at most. */
  private async create(attempt: Attempt, request: CreateTransferRequest): Promise<Transfer> {
    for (let retry = 0; ; retry++) {
      this.guardSend(attempt);
      try {
        return await this.api.createTransfer(request);
      } catch (error) {
        if (!(error instanceof AwxHttpError) || error.status !== 429 || retry >= RATE_LIMIT_RETRIES) throw error;
        const backoff = MIN_RATE_LIMIT_BACKOFF_MS * 2 ** retry;
        await this.sleep(Math.min(Math.max(error.retryAfterMs ?? 1_000 * 2 ** retry, backoff), MAX_RATE_LIMIT_WAIT_MS));
      }
    }
  }

  private async resolveDuplicate(attempt: Attempt, error: AwxHttpError): Promise<Transfer | null> {
    const parsed = DuplicateBodySchema.safeParse(error.body);
    const id = parsed.success ? parsed.data.details.id : undefined;
    try {
      return typeof id === "string" ? await this.api.getTransfer(id) : await this.lookup(attempt);
    } catch {
      return null;
    }
  }

  /** The create may or may not have reached Airwallex. Look it up by the same request_id; never mint another. */
  private async resolveAmbiguity(attempt: Attempt, cause: unknown): Promise<SubmitResult> {
    const message = cause instanceof Error ? cause.message : String(cause);
    this.ledger.tx(() => {
      // One CREATE_AMBIGUOUS per distinct error, not one per sweep that hits the same outage.
      const last = this.ledger
        .events(attempt.obligationId)
        .findLast((e) => e.type === "CREATE_AMBIGUOUS" && AttemptRefSchema.safeParse(e.payload).data?.attemptId === attempt.id);
      if (last && AmbiguousPayloadSchema.safeParse(last.payload).data?.error === message) return;
      this.ledger.updateAttempt(attempt.id, { lastError: message });
      this.ledger.append(attempt.obligationId, "CREATE_AMBIGUOUS", { attemptId: attempt.id, error: message });
    });
    try {
      const found = await this.lookup(attempt);
      if (found) {
        return { outcome: "ADOPTED_AFTER_AMBIGUITY", attempt: this.adoptSent(attempt, this.checked(attempt, found), "ambiguity_lookup") };
      }
    } catch (lookupError) {
      if (lookupError instanceof LedgerMismatchError || lookupError instanceof StateConflict) throw lookupError;
    }
    return { outcome: "PENDING_RECOVERY", attempt: this.ledger.requireAttempt(attempt.id) };
  }

  /** Looks the attempt's request_id up, reaching back to before the intent: Airwallex's default window is only 30 days. */
  private lookup(attempt: Attempt): Promise<Transfer | null> {
    const from = new Date(Date.parse(attempt.createdAt) - LOOKUP_LEAD_MS).toISOString();
    return this.api.findTransferByRequestId(attempt.requestId, from);
  }

  /** Records a lookup/send problem on the attempt, once per distinct message (a repeated sweep writes nothing). */
  private noteError(attempt: Attempt, message: string): void {
    if (this.ledger.requireAttempt(attempt.id).lastError !== message) this.ledger.updateAttempt(attempt.id, { lastError: message });
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

  /**
   * A transfer sharing our request_id but not our terms is never adopted: the lock holds and a person looks. The
   * escalation is written once: a later sweep that sees the same mismatch changes nothing.
   */
  private checked(attempt: Attempt, transfer: Transfer): Transfer {
    const matches =
      transfer.beneficiary_id === attempt.beneficiaryId &&
      transfer.transfer_currency === attempt.currency &&
      toMinor(transfer.transfer_amount, transfer.transfer_currency) === attempt.amountMinor &&
      (transfer.request_id === undefined || transfer.request_id === attempt.requestId);
    if (matches) return transfer;

    const detail = `airwallex transfer ${transfer.id} (${transfer.transfer_amount} ${transfer.transfer_currency} to ${transfer.beneficiary_id}) does not match intent`;
    this.ledger.tx(() => {
      const obligation = this.ledger.requireObligation(attempt.obligationId);
      if (obligation.status === "ESCALATED" && obligation.escalationReason === detail) return;
      this.noteError(attempt, detail);
      this.ledger.append(attempt.obligationId, "TRANSFER_MISMATCH", { attemptId: attempt.id, transferId: transfer.id, detail });
      this.ledger.escalate(attempt.obligationId, detail);
    });
    throw new LedgerMismatchError(attempt.id, detail);
  }

  /** `adopt` for a transfer this process just created or looked up after sending: a released attempt is no success. */
  private adoptSent(attempt: Attempt, transfer: Transfer, via: string): Attempt {
    const adopted = this.adopt(attempt, transfer, via);
    if (adopted.state === "ABANDONED") {
      throw new StateConflict(
        `attempt ${attempt.id} was released while its create was in flight, and Airwallex created transfer ${transfer.id} (${transfer.status}) for it anyway; it is recorded and the obligation escalated for a person to decide`,
      );
    }
    return adopted;
  }

  private adopt(attempt: Attempt, transfer: Transfer, via: string): Attempt {
    return this.ledger.tx(() => {
      const current = this.ledger.requireAttempt(attempt.id);
      if (current.state === "ABANDONED") return this.recordOrphan(current, transfer, via);
      if (current.state === "DEAD") return this.adoptAfterDead(current, transfer, via);
      if (this.isStale(current, transfer)) return current;

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
      this.recordFailure(current, transfer);
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

  /** The failure code is a column the replacement policy trusts, so every change to it is an event `verifyChain` can replay. */
  private recordFailure(before: Attempt, transfer: Transfer): void {
    const code = transfer.failure?.code;
    if (code === undefined || code === before.failureCode) return;
    this.ledger.append(before.obligationId, "FAILURE_RECORDED", { attemptId: before.id, transferId: transfer.id, failureCode: code });
  }

  /**
   * Airwallex stamps `updated_at` with whole-second resolution. A snapshot older than the applied one is dropped, and
   * so is one with the same stamp (or none) that sits earlier in the status order: a late SENT must not undo a PAID.
   */
  private isStale(current: Attempt, transfer: Transfer): boolean {
    if (transfer.updated_at !== undefined && current.awxUpdatedAt !== null && Date.parse(transfer.updated_at) < Date.parse(current.awxUpdatedAt)) {
      return true;
    }
    const sameInstant = transfer.updated_at === undefined || transfer.updated_at === current.awxUpdatedAt;
    if (!sameInstant || current.awxStatus === null) return false;
    const incoming = STATUS_RANK[transfer.status];
    const applied = STATUS_RANK[current.awxStatus];
    return incoming !== undefined && applied !== undefined && incoming < applied;
  }

  /**
   * A DEAD attempt is not a live transfer, with one exception: a transfer an older build released while it was only
   * held in an approval state. Airwallex lets those be edited and resubmitted, so it keeps being polled; CANCELLED
   * ends it, and any other status is a transfer that can pay after its lock was freed. That is recorded once, any
   * certificate is withdrawn and the obligation is escalated.
   */
  private adoptAfterDead(current: Attempt, transfer: Transfer, via: string): Attempt {
    if (transfer.status === current.awxStatus || this.isStale(current, transfer)) return current;
    const wasHeld = current.awxStatus !== null && NEVER_EXECUTED_STATUSES.includes(current.awxStatus);
    if (transfer.status === "CANCELLED") {
      if (!wasHeld) return current;
      const updated = this.ledger.updateAttempt(current.id, {
        awxStatus: transfer.status,
        awxUpdatedAt: transfer.updated_at,
        failureCode: transfer.failure?.code ?? current.failureCode ?? undefined,
      });
      this.ledger.append(current.obligationId, "TRANSFER_STATUS", {
        attemptId: current.id, transferId: transfer.id, from: current.awxStatus, to: transfer.status, via, failureCode: transfer.failure?.code ?? null,
      });
      this.recordFailure(current, transfer);
      return updated;
    }

    const seen = this.ledger.events(current.obligationId).some((e) => {
      if (e.type !== "STATUS_AFTER_DEAD") return false;
      const p = StatusAfterDeadSchema.safeParse(e.payload);
      return p.success && p.data.transferId === transfer.id && p.data.status === transfer.status;
    });
    if (seen) return current;
    this.ledger.append(current.obligationId, "STATUS_AFTER_DEAD", { attemptId: current.id, transferId: transfer.id, status: transfer.status });
    this.withdrawAndEscalate(
      current.obligationId,
      `transfer ${transfer.id} of released attempt ${current.id} is ${transfer.status} at Airwallex; it can still pay although its lock was freed`,
    );
    return current;
  }

  /**
   * A transfer exists for an attempt that was ABANDONED (its create was released or rejected, yet it landed). The
   * attempt stays ABANDONED, the transfer is recorded as an orphan and the obligation is escalated, once per
   * transfer: a person decides what happens to it. Never throws on the lock index.
   */
  private recordOrphan(current: Attempt, transfer: Transfer, via: string): Attempt {
    const seen = this.ledger.events(current.obligationId).some((e) => {
      if (e.type !== "TRANSFER_AFTER_ABANDON") return false;
      const p = TransferRefSchema.safeParse(e.payload);
      return p.success && p.data.attemptId === current.id && p.data.transferId === transfer.id;
    });
    if (seen) return current;
    this.ledger.append(current.obligationId, "TRANSFER_AFTER_ABANDON", {
      attemptId: current.id,
      transferId: transfer.id,
      requestId: current.requestId,
      status: transfer.status,
      via,
    });
    this.withdrawAndEscalate(
      current.obligationId,
      `transfer ${transfer.id} (${transfer.status}) exists at Airwallex for attempt ${current.id}, which had been released as never sent; a person must decide what it is`,
    );
    return current;
  }

  private withdrawAndEscalate(obligationId: string, reason: string): void {
    if (this.ledger.getCertificateJson(obligationId)) this.ledger.revokeCertificate(obligationId, reason);
    else this.ledger.escalate(obligationId, reason);
  }

  /** Airwallex definitively refused a first send. Compare-and-set: an attempt another process already adopted is left alone. */
  private abandon(attempt: Attempt, reason: string): SubmitResult {
    return this.ledger.tx(() => {
      const abandoned = this.ledger.abandonIntent(attempt.id, reason);
      if (!abandoned) {
        const current = this.ledger.requireAttempt(attempt.id);
        return { outcome: current.state === "ABANDONED" ? "REJECTED" : "ADOPTED_AFTER_AMBIGUITY", attempt: current };
      }
      this.ledger.append(attempt.obligationId, "ATTEMPT_ABANDONED", { attemptId: attempt.id, reason });
      this.ledger.refreshObligationStatus(attempt.obligationId);
      return { outcome: "REJECTED", attempt: abandoned };
    });
  }
}
