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
