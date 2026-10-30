import { issueApproval, newNonce, type Approval } from "../approval/approval";
import type { BalanceApi } from "../airwallex/types";
import { canonicalJson, sha256Hex } from "../canonical";
import { ApprovalRejected, AutoReplacementRefused } from "../errors";
import type { PayoutGateway, SubmitResult } from "../gateway/gateway";
import { paidObservedAt, TransferStatusPayloadSchema } from "../ledger/events";
import type { Ledger, LedgerEvent, Method } from "../ledger/ledger";
import { toMinor } from "../money";
import type { SupplierEvidence } from "./evidence";
import { DEFAULT_POLICY, decide, type CommanderPolicy, type Decision, type IncidentFacts } from "./policy";

export interface CommanderConfig {
  ledger: Ledger;
  gateway: PayoutGateway;
  balances: BalanceApi;
  /** Signs approvals. Held by this process only; the model never receives it. */
  secret: string;
  policy?: CommanderPolicy;
  now?: () => Date;
}

export interface Assessment {
  obligationId: string;
  facts: IncidentFacts;
  decision: Decision;
  /** Binds any approval issued from this assessment to the exact evidence and decision the approver saw. */
  evidenceHash: string;
}

/** Terms a human may change when replacing a failed attempt. Amount and currency can never change. */
export interface HumanApprovalInput {
  obligationId: string;
  /** Authenticated identity of the approver; authentication happens in the caller. */
  approver: string;
  note: string;
  /** The `evidenceHash` of the assessment the approver was shown. A different current hash means they approved stale facts. */
  evidenceHash: string;
  evidence?: SupplierEvidence | null;
  beneficiaryId?: string;
  method?: Method;
  reason?: string;
}

const APPROVAL_TTL_MS = 5 * 60_000;

/** When the ledger last saw `attemptId` become FAILED, or null if it never did. */
function failedObservedAt(events: LedgerEvent[], attemptId: string): string | null {
  let at: string | null = null;
  for (const event of events) {
    if (event.type !== "TRANSFER_STATUS") continue;
    const payload = TransferStatusPayloadSchema.safeParse(event.payload);
    if (payload.success && payload.data.attemptId === attemptId && payload.data.to === "FAILED" && payload.data.from !== "FAILED") at = event.ts;
  }
  return at;
}

/** Replacements made under a code-granted (POLICY) approval. The first payment is not a replacement. */
function automaticReplacements(events: LedgerEvent[]): number {
  return events.filter((e) => {
    if (e.type !== "ATTEMPT_INTENT") return false;
    const p = e.payload as { mode?: unknown; replaces?: unknown } | null;
    return p?.mode === "POLICY" && p.replaces != null;
  }).length;
}

export class Commander {
  private readonly ledger: Ledger;
  private readonly gateway: PayoutGateway;
  private readonly balances: BalanceApi;
  private readonly secret: string;
  private readonly policy: CommanderPolicy;
  private readonly now: () => Date;

  constructor(config: CommanderConfig) {
    this.ledger = config.ledger;
    this.gateway = config.gateway;
    this.balances = config.balances;
    this.secret = config.secret;
    this.policy = config.policy ?? DEFAULT_POLICY;
    this.now = config.now ?? (() => new Date());
  }

  /** Refreshes from Airwallex, then decides. Moves no money. */
  async assess(obligationId: string, evidence: SupplierEvidence | null = null): Promise<Assessment> {
    await this.gateway.sync(obligationId);
    const obligation = this.ledger.requireObligation(obligationId);
    const attempts = this.ledger.attemptsFor(obligationId);
    const latest = attempts.at(-1);

    const balance = await this.balances.getAvailableBalance(obligation.currency).catch(() => null);
    const events = this.ledger.events(obligationId);
    const facts: IncidentFacts = {
      obligation,
      attempts,
      paidObservedAt: latest?.state === "PAID" ? paidObservedAt(events, latest.id) : null,
      failedObservedAt: latest?.awxStatus === "FAILED" ? failedObservedAt(events, latest.id) : null,
      automaticReplacements: automaticReplacements(events),
      walletAvailableMinor: balance === null ? null : toMinor(balance, obligation.currency),
      evidence,
      now: this.now(),
    };
    const decision = decide(facts, this.policy);
    const evidenceHash = sha256Hex(
      canonicalJson({
        evidence,
        recommended: decision.recommended,
        reasons: decision.reasons,
        attempts: attempts.map((a) => ({ id: a.id, state: a.state, failureCode: a.failureCode })),
      }),
    );
    return { obligationId, facts, decision, evidenceHash };
  }

  /**
   * Replaces a failed attempt under a policy-signed approval, only when the policy says it is safe to do
   * automatically: transient failure, funds returned, wallet covers it, amount within the automatic limit.
   */
  async replaceAutomatically(obligationId: string, evidence: SupplierEvidence | null = null): Promise<SubmitResult> {
    const assessment = await this.assess(obligationId, evidence);
    const { decision } = assessment;
    if (decision.recommended !== "REPLACE" || !decision.allowed.includes("REPLACE") || !decision.replacement?.autoApprovable) {
      throw new AutoReplacementRefused(obligationId, decision);
    }
    const previous = assessment.facts.attempts.at(-1)!;
    const approval = issueApproval(
      {
        obligationId,
        amountMinor: previous.amountMinor,
        currency: previous.currency,
        beneficiaryId: previous.beneficiaryId,
        method: previous.method,
        reason: previous.reason,
        replacesAttemptId: previous.id,
        evidenceHash: assessment.evidenceHash,
        mode: "POLICY",
        approver: "policy:commander",
        expiresAt: new Date(this.now().getTime() + APPROVAL_TTL_MS).toISOString(),
        nonce: newNonce(),
      },
      this.secret,
    );
    return this.gateway.submit(approval);
  }

  /**
   * Builds the approval a named human has authorized. The gateway still applies the playbook: a note unlocks
   * AFTER_CHANGE and FORBIDDEN replacements but cannot change the amount or skip the lock.
   */
  async humanApproval(input: HumanApprovalInput): Promise<Approval> {
    const assessment = await this.assess(input.obligationId, input.evidence ?? null);
    if (assessment.evidenceHash !== input.evidenceHash) {
      throw new ApprovalRejected("stale_evidence", "the incident changed since the approver reviewed it; review the current assessment and approve again");
    }
    const previous = assessment.facts.attempts.at(-1) ?? null;
    const obligation = this.ledger.requireObligation(input.obligationId);
    return issueApproval(
      {
        obligationId: obligation.id,
        amountMinor: obligation.amountMinor,
        currency: obligation.currency,
        beneficiaryId: input.beneficiaryId ?? previous?.beneficiaryId ?? obligation.beneficiaryId,
        method: input.method ?? previous?.method ?? obligation.method,
        reason: input.reason ?? previous?.reason ?? obligation.reason,
        replacesAttemptId: previous?.id ?? null,
        evidenceHash: assessment.evidenceHash,
        mode: "HUMAN",
        approver: input.approver,
        note: input.note,
        expiresAt: new Date(this.now().getTime() + APPROVAL_TTL_MS).toISOString(),
        nonce: newNonce(),
      },
      this.secret,
    );
  }
}
