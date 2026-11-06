export class DuplicateLockError extends Error {
  constructor(readonly obligationId: string) {
    super(`obligation ${obligationId} already has an open payout attempt`);
    this.name = "DuplicateLockError";
  }
}

export type ApprovalRejectReason =
  | "malformed"
  | "bad_signature"
  | "expired"
  | "replayed"
  | "stale"
  | "stale_evidence"
  | "terms_mismatch";

export class ApprovalRejected extends Error {
  constructor(readonly reason: ApprovalRejectReason, message: string) {
    super(`approval rejected (${reason}): ${message}`);
    this.name = "ApprovalRejected";
  }
}

export class ReplacementDenied extends Error {
  constructor(readonly failureCode: string | null, readonly policy: string, message: string) {
    super(`replacement denied (${policy}, failure ${failureCode ?? "none"}): ${message}`);
    this.name = "ReplacementDenied";
  }
}

export class ObligationNotPayable extends Error {
  constructor(readonly obligationId: string, message: string) {
    super(`obligation ${obligationId} is not payable: ${message}`);
    this.name = "ObligationNotPayable";
  }
}

/** Airwallex returned a transfer that does not match what the ledger intended. Never auto-resolved. */
export class LedgerMismatchError extends Error {
  constructor(readonly attemptId: string, message: string) {
    super(`attempt ${attemptId}: ${message}`);
    this.name = "LedgerMismatchError";
  }
}

/** The Closer found reasons the incident cannot be certified yet. Each blocker is a sentence a person can act on. */
export class NotClosable extends Error {
  constructor(readonly obligationId: string, readonly blockers: string[]) {
    super(`obligation ${obligationId} cannot be closed:\n - ${blockers.join("\n - ")}`);
    this.name = "NotClosable";
  }
}

/** The Commander declined to replace on its own. `decision.reasons` says why; a human may still approve. */
export class AutoReplacementRefused extends Error {
  constructor(readonly obligationId: string, readonly decision: { recommended: string; reasons: string[] }) {
    super(`obligation ${obligationId}: automatic replacement refused (recommended ${decision.recommended}): ${decision.reasons.join(" ")}`);
    this.name = "AutoReplacementRefused";
  }
}

/** A drafted supplier reply was refused: the action is not allowed right now, or the text breaks a rule. */
export class DraftRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftRejected";
  }
}

/** The database refused a second conversion for one replacement (the one-conversion-per-replacement index). */
export class DuplicateConversionError extends Error {
  constructor(readonly obligationId: string, readonly forAttemptId: string) {
    super(`obligation ${obligationId} already has a conversion for replacing attempt ${forAttemptId}; Tessera books one per replacement`);
    this.name = "DuplicateConversionError";
  }
}

/**
 * Tessera will not convert currency to fund this replacement. `reasons` are sentences a person can act on (the
 * arithmetic included); `plan` is the code-computed plan when there is one, so a person can see what was refused.
 * `replan` marks a refusal that a fresh plan and quote may cure (the wallets or the quote moved since the plan).
 */
export class FundingRefused extends Error {
  constructor(readonly obligationId: string, readonly reasons: string[], readonly plan: { summary: string } | null = null, readonly replan = false) {
    super(`obligation ${obligationId}: funding refused: ${reasons.join(" ")}`);
    this.name = "FundingRefused";
  }
}

/** The requested change does not apply to the record's current state (e.g. resolving an escalation that is not open). */
export class StateConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateConflict";
  }
}

export type WebhookRejectReason = "missing_header" | "bad_signature" | "stale" | "malformed";

/** An inbound Airwallex webhook failed verification. Nothing in it is acted on. */
export class WebhookRejected extends Error {
  constructor(readonly reason: WebhookRejectReason, message: string) {
    super(`webhook rejected (${reason}): ${message}`);
    this.name = "WebhookRejected";
  }
}
