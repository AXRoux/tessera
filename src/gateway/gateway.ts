import { z } from "zod";
import {
  AwxHttpError,
  type CreateTransferRequest,
  type PayoutApi,
  type Transfer,
} from "../airwallex/types";
import { verifyApproval, type Approval, type ApprovalPayload } from "../approval/approval";
import { lookupFailure } from "../domain/playbook";
import {
  ApprovalRejected,
  DuplicateLockError,
  LedgerMismatchError,
  ObligationNotPayable,
  ReplacementDenied,
} from "../errors";
import type { Attempt, AttemptState, Ledger } from "../ledger/ledger";
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
}

/** Airwallex's duplicate_request_id error names the transfer that already used the request_id. */
const DuplicateBodySchema = z.looseObject({ details: z.looseObject({ id: z.string() }) });

const KNOWN_STATUSES = [
  "SCHEDULED", "IN_APPROVAL", "APPROVAL_RECALLED", "APPROVAL_REJECTED", "APPROVAL_BLOCKED",
  "OVERDUE", "PROCESSING", "SENT", "PAID", "FAILED", "CANCELLED",
];

/**
 * Unknown statuses keep the lock. FAILED also keeps it: the money is only back once Airwallex reaches CANCELLED.
 */
function classify(status: string): Extract<AttemptState, "LIVE" | "PAID" | "DEAD"> {
  if (status === "PAID") return "PAID";
  if (status === "CANCELLED") return "DEAD";
  return "LIVE";
}

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
  const humanVouches = p.mode === "HUMAN" && (p.note?.trim().length ?? 0) >= 10;
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

  constructor(config: GatewayConfig) {
    if (config.approvalSecret.length < 32) throw new Error("approval secret must be at least 32 characters");
    this.ledger = config.ledger;
    this.api = config.api;
    this.secret = config.approvalSecret;
    this.now = config.now ?? (() => new Date());
    this.newRequestId = config.newRequestId ?? (() => crypto.randomUUID());
    this.maxIntentAgeMs = config.maxIntentAgeMs ?? 24 * 3600_000;
  }

  /**
   * Pays an obligation exactly once. The intent (with its request_id) is committed before the network call, so a
   * crash at any later point is resolved by looking the request_id up, never by minting a new one.
   */
  async submit(approval: Approval): Promise<SubmitResult> {
    const payload = verifyApproval(approval, this.secret, this.now());
    return this.execute(this.begin(payload));
  }

  /** Resolves attempts left in INTENT by a crash or outage. Safe to run repeatedly. */
  async recover(): Promise<SubmitResult[]> {
    const results: SubmitResult[] = [];
    for (const attempt of this.ledger.intentAttempts()) {
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
        // Cannot prove the transfer does not exist, so the lock stays and a person decides.
        this.ledger.escalate(attempt.obligationId, `attempt ${attempt.id} unresolved for ${Math.round(age / 3600_000)}h`);
        results.push({ outcome: "PENDING_RECOVERY", attempt });
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

  // ---- phase 1: durable intent ------------------------------------------------

  private begin(p: ApprovalPayload): Attempt {
    return this.ledger.tx(() => {
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

      const prev = this.ledger.latestAttempt(obligation.id);
      if (prev && (prev.state === "INTENT" || prev.state === "LIVE" || prev.state === "PAID")) {
        throw new DuplicateLockError(obligation.id);
      }
      if ((prev?.id ?? null) !== p.replacesAttemptId) {
        throw new ApprovalRejected("stale", `approval replaces ${p.replacesAttemptId}, latest attempt is ${prev?.id ?? "none"}`);
      }

      if (!prev) {
        if (p.beneficiaryId !== obligation.beneficiaryId || p.method !== obligation.method || p.reason !== obligation.reason) {
          throw new ApprovalRejected("terms_mismatch", "first attempt must use the obligation's own terms");
        }
      } else if (prev.state === "DEAD") {
        checkReplacement(prev, p);
      }

      const attempt = this.ledger.insertAttempt({
        obligationId: obligation.id,
        seq: (prev?.seq ?? 0) + 1,
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
        replaces: prev?.id ?? null,
        replacesFailureCode: prev?.failureCode ?? null,
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
      const transfer = await this.api.createTransfer(request);
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

  private async resolveDuplicate(attempt: Attempt, error: AwxHttpError): Promise<Transfer | null> {
    const parsed = DuplicateBodySchema.safeParse(error.body);
    const id = parsed.success ? parsed.data.details.id : undefined;
    try {
      return typeof id === "string" ? await this.api.getTransfer(id) : await this.api.findTransferByRequestId(attempt.requestId);
    } catch {
      return null;
    }
  }

  /** The create may or may not have landed. Look it up by the same request_id; never mint another. */
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
        if (transfer.status !== "CANCELLED") {
          this.ledger.append(current.obligationId, "STATUS_AFTER_DEAD", { attemptId: current.id, transferId: transfer.id, status: transfer.status });
        }
        return current;
      }

      const next = classify(transfer.status);
      const feeCurrency = transfer.fee_currency ?? transfer.transfer_currency;
      const payerCurrency = transfer.source_currency ?? transfer.transfer_currency;
      const updated = this.ledger.updateAttempt(current.id, {
        state: next,
        transferId: transfer.id,
        awxStatus: transfer.status,
        failureCode: transfer.failure?.code ?? current.failureCode ?? undefined,
        failureMessage: transfer.failure?.message ?? current.failureMessage ?? undefined,
        feeMinor: toMinor(transfer.fee_amount, feeCurrency),
        payerPaysMinor: transfer.amount_payer_pays === undefined ? undefined : toMinor(transfer.amount_payer_pays, payerCurrency),
        lastError: null,
      });

      if (current.awxStatus !== transfer.status) {
        this.ledger.append(current.obligationId, "TRANSFER_STATUS", {
          attemptId: current.id,
          transferId: transfer.id,
          from: current.awxStatus,
          to: transfer.status,
          via,
          failureCode: transfer.failure?.code ?? null,
        });
      }
      if (!KNOWN_STATUSES.includes(transfer.status)) {
        this.ledger.append(current.obligationId, "UNKNOWN_STATUS", { attemptId: current.id, status: transfer.status });
      }
      if (current.state === "PAID" && next !== "PAID") {
        this.ledger.append(current.obligationId, "LATE_FAILURE", {
          attemptId: current.id,
          transferId: transfer.id,
          status: transfer.status,
          failureCode: transfer.failure?.code ?? null,
        });
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
