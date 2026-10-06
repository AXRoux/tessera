import { lookupFailure, type FailureClass, type ReplacePolicy } from "../domain/playbook";
import type { Attempt, Method, Obligation } from "../ledger/ledger";
import type { SupplierEvidence } from "./evidence";

export type ActionKind =
  | "NONE"
  | "WAIT"
  | "RECOVER_INTENT"
  | "SEND_STATUS_TO_SUPPLIER"
  | "SEND_PROOF_TO_SUPPLIER"
  | "REQUEST_CORRECTION"
  | "REPLACE"
  | "CLOSE"
  | "ESCALATE";

export type Severity = "ROUTINE" | "ATTENTION" | "CRITICAL";

/** Thresholds live here, in code. The model never sees or sets them. */
export interface CommanderPolicy {
  /** How long a transfer may be in flight before silence stops being normal. */
  settlementSlaHours: Record<Method, number>;
  /** Largest replacement the Commander may approve on its own, per currency (minor units). Absent = never automatic. */
  autoReplaceLimitMinor: Record<string, number>;
  /** PAID is not final; how long it must stay PAID before the incident may close. */
  paidHoldMs: number;
}

export const DEFAULT_POLICY: CommanderPolicy = {
  settlementSlaHours: { LOCAL: 48, SWIFT: 120 },
  autoReplaceLimitMinor: { USD: 500_000, EUR: 500_000, GBP: 500_000 },
  paidHoldMs: 24 * 3600_000,
};

export interface IncidentFacts {
  obligation: Pick<Obligation, "id" | "amountMinor" | "currency" | "status" | "escalationReason">;
  /** Ordered by seq. */
  attempts: Attempt[];
  /** When the latest attempt was first seen PAID. */
  paidObservedAt: string | null;
  /** Null when the balance could not be read. */
  walletAvailableMinor: number | null;
  evidence: SupplierEvidence | null;
  now: Date;
}

export interface ReplacementAssessment {
  failureClass: FailureClass;
  policy: ReplacePolicy;
  /** What must change before an automatic replacement is acceptable, if anything. */
  needsChange: string | null;
  autoApprovable: boolean;
}

export interface Decision {
  recommended: ActionKind;
  /** Actions that are safe to take now. `recommended` is always one of them. */
  allowed: ActionKind[];
  /** Actions someone might expect, and why the code refuses them. */
  blocked: Array<{ action: ActionKind; reason: string }>;
  reasons: string[];
  severity: Severity;
  recheckAt: string | null;
  replacement: ReplacementAssessment | null;
}

const SEVERITY_RANK: Record<Severity, number> = { ROUTINE: 0, ATTENTION: 1, CRITICAL: 2 };
const HOUR_MS = 3600_000;

export function decide(facts: IncidentFacts, policy: CommanderPolicy = DEFAULT_POLICY): Decision {
  const { obligation, evidence, now } = facts;
  const latest = facts.attempts.at(-1) ?? null;

  const candidates: ActionKind[] = [];
  const blocked: Decision["blocked"] = [];
  const reasons: string[] = [];
  let severity: Severity = "ROUTINE";
  let recheckAt: string | null = null;
  let replacement: ReplacementAssessment | null = null;
  let forced: ActionKind | null = null;
  let fromState: ActionKind = "NONE";

  const raise = (next: Severity) => {
    if (SEVERITY_RANK[next] > SEVERITY_RANK[severity]) severity = next;
  };
  const refuse = (action: ActionKind, reason: string) => blocked.push({ action, reason });
  const finish = (): Decision => {
    const recommended = forced ?? fromState;
    const refused = new Set(blocked.map((b) => b.action));
    const allowed = [...new Set([recommended, ...candidates])].filter((a) => a === "NONE" || !refused.has(a));
    return { recommended, allowed, blocked, reasons, severity, recheckAt, replacement };
  };

  if (obligation.status === "CLOSED") {
    reasons.push("The obligation is closed and certified.");
    return finish();
  }
  if (!latest) {
    reasons.push("No payment has been attempted, so there is no incident to command.");
    return finish();
  }

  // 1. Signals that override the state machine: a human must look.
  if (obligation.status === "ESCALATED") {
    forced = "ESCALATE";
    raise("CRITICAL");
    candidates.push("ESCALATE");
    reasons.push(`Already escalated: ${obligation.escalationReason ?? "no reason recorded"}.`);
    refuse("REPLACE", "Escalated obligations are released only by a named human approval.");
  }
  if (evidence?.requestsDetailChange) {
    forced = "ESCALATE";
    raise("CRITICAL");
    candidates.push("ESCALATE");
    reasons.push("The supplier's message asks to change bank details. Verify by calling a number already on file; an emailed change is the classic payment-fraud pattern.");
    refuse("REPLACE", "New bank details arrived by message and are unverified.");
  }
  if (evidence?.containsEmbeddedInstructions) {
    raise("ATTENTION");
    reasons.push("The supplier's message contained instructions aimed at the assistant. They were ignored.");
  }
  if (evidence && !evidence.referencesObligation) {
    raise("ATTENTION");
    reasons.push("The message does not cite this obligation's reference; treat its claims as unmatched.");
  }
  const statementShowsCredit =
    evidence?.statementCredit != null &&
    evidence.statementCredit.currency === obligation.currency &&
    evidence.statementCredit.amountMinor === obligation.amountMinor;

  // 2. The state of the latest attempt.
  switch (latest.state) {
    case "INTENT":
      fromState = "RECOVER_INTENT";
      candidates.push("RECOVER_INTENT", "ESCALATE");
      raise("ATTENTION");
      reasons.push("A payout intent was written but its outcome is unknown. Look it up by its request_id before anything else.");
      refuse("REPLACE", "The unresolved intent holds the lock; a second payment could duplicate it.");
      break;

    case "LIVE": {
      refuse("REPLACE", "The original may still settle; replacing it could pay the supplier twice.");
      if (latest.awxStatus === "FAILED") {
        fromState = "WAIT";
        candidates.push("WAIT");
        recheckAt = new Date(now.getTime() + 5 * 60_000).toISOString();
        reasons.push("Airwallex marked the transfer FAILED. The funds are returned only at CANCELLED, so the lock holds until then.");
        break;
      }
      const slaMs = policy.settlementSlaHours[latest.method] * HOUR_MS;
      const ageMs = now.getTime() - Date.parse(latest.createdAt);
      if (ageMs <= slaMs) {
        fromState = "WAIT";
        candidates.push("WAIT", "SEND_STATUS_TO_SUPPLIER");
        recheckAt = new Date(Date.parse(latest.createdAt) + slaMs).toISOString();
        reasons.push(`In flight ${Math.floor(ageMs / HOUR_MS)}h of an expected ${policy.settlementSlaHours[latest.method]}h (${latest.method}). Waiting is correct.`);
        if (evidence?.claimsNonReceipt) {
          raise("ATTENTION");
          reasons.push("The supplier reports non-receipt, but the transfer is still inside its settlement window.");
        }
      } else {
        fromState = "ESCALATE";
        candidates.push("ESCALATE", "WAIT");
        raise("ATTENTION");
        reasons.push(`In flight ${Math.floor(ageMs / HOUR_MS)}h, past the expected ${policy.settlementSlaHours[latest.method]}h. Non-delivery cannot be proven from here; ask Airwallex to trace it.`);
      }
      break;
    }

    case "PAID": {
      refuse("REPLACE", "PAID holds the lock: the money left our account and may be sitting at the supplier's bank.");
      if (evidence?.claimsNonReceipt && !statementShowsCredit) {
        fromState = "SEND_PROOF_TO_SUPPLIER";
        candidates.push("SEND_PROOF_TO_SUPPLIER", "ESCALATE", "WAIT");
        raise("ATTENTION");
        reasons.push("Airwallex reports PAID while the supplier says nothing arrived. Send proof of payment and ask their bank to trace; do not pay again.");
        break;
      }
      if (statementShowsCredit) reasons.push("The supplier's own statement shows the credit, confirming receipt.");
      const heldMs = facts.paidObservedAt ? now.getTime() - Date.parse(facts.paidObservedAt) : 0;
      if (facts.paidObservedAt && heldMs >= policy.paidHoldMs) {
        fromState = "CLOSE";
        candidates.push("CLOSE");
        reasons.push("PAID has held past the hold window with no return. The Closer can now reconcile and certify.");
      } else {
        fromState = "WAIT";
        candidates.push("WAIT");
        recheckAt = facts.paidObservedAt ? new Date(Date.parse(facts.paidObservedAt) + policy.paidHoldMs).toISOString() : null;
        reasons.push("PAID is not final: a bank can still return it. Hold before closing.");
      }
      break;
    }

    case "DEAD": {
      const entry = lookupFailure(latest.failureCode);
      reasons.push(`Attempt #${latest.seq} ended CANCELLED with ${latest.failureCode ?? "no failure code"}. ${entry.guidance}`);
      replacement = {
        failureClass: entry.class,
        policy: entry.replace,
        needsChange: entry.change ? entry.change.toLowerCase() : null,
        autoApprovable: false,
      };

      if (statementShowsCredit) {
        forced = "ESCALATE";
        raise("CRITICAL");
        candidates.push("ESCALATE");
        reasons.push("The supplier's statement shows a credit of the full amount even though Airwallex cancelled the transfer. The supplier may already hold the money.");
        refuse("REPLACE", "A replacement could pay the supplier twice.");
        break;
      }
      if (entry.replace === "FORBIDDEN") {
        fromState = "ESCALATE";
        candidates.push("ESCALATE");
        raise(entry.class === "POSSIBLE_DUPLICATE" || entry.class === "COMPLIANCE_OR_RECALL" ? "CRITICAL" : "ATTENTION");
        refuse("REPLACE", "This failure class never replaces automatically; a named human must vouch in writing.");
        break;
      }
      if (entry.replace === "AFTER_CHANGE") {
        fromState = "REQUEST_CORRECTION";
        candidates.push("REQUEST_CORRECTION", "ESCALATE");
        raise("ATTENTION");
        refuse("REPLACE", `Needs a changed ${replacement.needsChange} first, or a human approval with a written note.`);
        break;
      }

      const neededMinor = latest.amountMinor + (latest.feeMinor ?? 0);
      const limit = policy.autoReplaceLimitMinor[obligation.currency];
      if (facts.walletAvailableMinor !== null && facts.walletAvailableMinor < neededMinor) {
        fromState = "ESCALATE";
        candidates.push("ESCALATE");
        raise("ATTENTION");
        reasons.push(`The wallet holds ${facts.walletAvailableMinor} minor units but a replacement needs ${neededMinor}. Top up first.`);
        refuse("REPLACE", "Insufficient wallet balance.");
      } else if (limit !== undefined && latest.amountMinor <= limit) {
        fromState = "REPLACE";
        candidates.push("REPLACE", "ESCALATE");
        replacement.autoApprovable = true;
        reasons.push("Transient failure and the original is cancelled with funds returned. A replacement is within the automatic limit.");
      } else {
        fromState = "REPLACE";
        candidates.push("REPLACE", "ESCALATE");
        raise("ATTENTION");
        reasons.push("Replacement is allowed but exceeds the automatic limit; a human must approve it.");
      }
      break;
    }

    case "ABANDONED":
      fromState = "REQUEST_CORRECTION";
      candidates.push("REQUEST_CORRECTION", "REPLACE", "ESCALATE");
      raise("ATTENTION");
      reasons.push(`Airwallex rejected the create outright (${latest.lastError ?? "no detail"}); nothing was sent. Fix the terms and retry.`);
      break;
  }

  return finish();
}
