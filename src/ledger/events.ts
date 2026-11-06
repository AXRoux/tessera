import { z } from "zod";
import type { AttemptState, LedgerEvent } from "./ledger";

/** Payload of a `TRANSFER_STATUS` event as the gateway writes it; readers parse instead of casting. */
export const TransferStatusPayloadSchema = z.object({
  attemptId: z.string(),
  transferId: z.string(),
  from: z.string().nullable(),
  to: z.string(),
  via: z.string(),
  failureCode: z.string().nullable(),
});
export type TransferStatusPayload = z.infer<typeof TransferStatusPayloadSchema>;

/**
 * What an Airwallex transfer status means for the lock. Unknown statuses keep it. FAILED also keeps it: the money is
 * only back once Airwallex reaches CANCELLED. Approval statuses that never executed are LIVE too: Airwallex lets a
 * user edit and resubmit them, so only CANCELLED frees the lock.
 */
export function classifyStatus(status: string): Extract<AttemptState, "LIVE" | "PAID" | "DEAD"> {
  if (status === "PAID") return "PAID";
  if (status === "CANCELLED") return "DEAD";
  return "LIVE";
}

/** When the ledger last saw `attemptId` become PAID, or null if it never did. */
export function paidObservedAt(events: LedgerEvent[], attemptId: string): string | null {
  let paidAt: string | null = null;
  for (const event of events) {
    if (event.type !== "TRANSFER_STATUS") continue;
    const payload = TransferStatusPayloadSchema.safeParse(event.payload);
    if (payload.success && payload.data.attemptId === attemptId && payload.data.to === "PAID") paidAt = event.ts;
  }
  return paidAt;
}

export interface AttemptTerms {
  beneficiaryId: string;
  amountMinor: number;
  currency: string;
  method: string;
  reason: string;
}

/** What an attempt's own events say about it. Optional fields are null for ledgers written before they were recorded. */
export interface ReplayedAttempt {
  state: AttemptState;
  transferId: string | null;
  awxStatus: string | null;
  obligationId: string | null;
  seq: number | null;
  requestId: string | null;
  nonce: string | null;
  terms: AttemptTerms | null;
  /** The last `FAILURE_RECORDED` code, or null if none. */
  failureCode: string | null;
  /**
   * Whether the table's `failureCode` can be checked against `failureCode` above: true for attempts whose intent was
   * written by a build that records every failure code, and for any attempt that has a `FAILURE_RECORDED` event.
   * An older attempt's failure code was sometimes set without an event, so it is not compared.
   */
  failureCodeVerifiable: boolean;
}

const AttemptRefSchema = z.looseObject({ attemptId: z.string() });
const TermsSchema = z.object({
  beneficiaryId: z.string(),
  amountMinor: z.number(),
  currency: z.string(),
  method: z.string(),
  reason: z.string(),
});
const IntentPayloadSchema = z.looseObject({
  attemptId: z.string(),
  seq: z.number().optional(),
  requestId: z.string().optional(),
  nonce: z.string().optional(),
  terms: TermsSchema.optional(),
  failuresRecorded: z.boolean().optional(),
});
const FailureRecordedSchema = z.looseObject({ attemptId: z.string(), failureCode: z.string() });
const ResolvedPayloadSchema = z.looseObject({
  attemptId: z.string(),
  to: z.enum(["INTENT", "LIVE", "PAID", "DEAD", "ABANDONED"]),
});

/**
 * Rebuilds every attempt from its own events, the way the gateway wrote them. A table row that disagrees with this
 * was edited outside the gateway, and an attempt that is here but not in the table was deleted.
 *
 * A transfer that shows up for an ABANDONED attempt is recorded as `TRANSFER_AFTER_ABANDON` and never changes the
 * attempt. Older builds adopted such a transfer into the attempt (writing `TRANSFER_STATUS`), and that history must
 * still verify, so the replay keeps applying those events.
 */
export function replayAttempts(events: LedgerEvent[]): Map<string, ReplayedAttempt> {
  const attempts = new Map<string, ReplayedAttempt>();
  for (const event of events) {
    if (event.type === "ATTEMPT_INTENT") {
      const p = IntentPayloadSchema.safeParse(event.payload);
      if (!p.success) continue;
      attempts.set(p.data.attemptId, {
        state: "INTENT",
        transferId: null,
        awxStatus: null,
        obligationId: event.obligationId,
        seq: p.data.seq ?? null,
        requestId: p.data.requestId ?? null,
        nonce: p.data.nonce ?? null,
        terms: p.data.terms ?? null,
        failureCode: null,
        failureCodeVerifiable: p.data.failuresRecorded === true,
      });
      continue;
    }
    if (event.type === "TRANSFER_STATUS") {
      const p = TransferStatusPayloadSchema.safeParse(event.payload);
      const current = p.success ? attempts.get(p.data.attemptId) : undefined;
      if (!p.success || !current) continue;
      if (current.state === "DEAD") {
        // A released approval-state transfer that Airwallex later cancelled: the lock stays free, the status moves on.
        attempts.set(p.data.attemptId, { ...current, awxStatus: p.data.to });
        continue;
      }
      attempts.set(p.data.attemptId, { ...current, state: classifyStatus(p.data.to), transferId: p.data.transferId, awxStatus: p.data.to });
      continue;
    }
    if (event.type === "FAILURE_RECORDED") {
      const p = FailureRecordedSchema.safeParse(event.payload);
      const current = p.success ? attempts.get(p.data.attemptId) : undefined;
      if (p.success && current) attempts.set(p.data.attemptId, { ...current, failureCode: p.data.failureCode, failureCodeVerifiable: true });
      continue;
    }
    if (event.type === "ATTEMPT_ABANDONED") {
      const ref = AttemptRefSchema.safeParse(event.payload);
      const current = ref.success ? attempts.get(ref.data.attemptId) : undefined;
      if (ref.success && current) attempts.set(ref.data.attemptId, { ...current, state: "ABANDONED" });
      continue;
    }
    if (event.type === "ATTEMPT_RESOLVED") {
      const p = ResolvedPayloadSchema.safeParse(event.payload);
      const current = p.success ? attempts.get(p.data.attemptId) : undefined;
      if (p.success && current) attempts.set(p.data.attemptId, { ...current, state: p.data.to });
    }
  }
  return attempts;
}

/** What an obligation's events say about its immutable fields and its current payment terms. */
export interface ReplayedObligation {
  reference: string;
  amountMinor: number;
  currency: string;
  beneficiaryId: string;
  method: string;
  reason: string;
}

const ObligationCreatedSchema = z.looseObject({
  reference: z.string(),
  beneficiaryId: z.string(),
  amountMinor: z.number(),
  currency: z.string(),
  method: z.string(),
  reason: z.string(),
});

/**
 * Amount, currency and reference are fixed at creation. Beneficiary, method and reason start there and follow the
 * latest `ATTEMPT_INTENT` (the gateway copies each approval's terms onto the obligation in the same transaction).
 */
export function replayObligations(events: LedgerEvent[]): Map<string, ReplayedObligation> {
  const obligations = new Map<string, ReplayedObligation>();
  for (const event of events) {
    if (event.obligationId === null) continue;
    if (event.type === "OBLIGATION_CREATED") {
      const p = ObligationCreatedSchema.safeParse(event.payload);
      if (p.success) obligations.set(event.obligationId, p.data);
      continue;
    }
    if (event.type === "ATTEMPT_INTENT") {
      const p = IntentPayloadSchema.safeParse(event.payload);
      const current = obligations.get(event.obligationId);
      if (p.success && p.data.terms && current) {
        const { beneficiaryId, method, reason } = p.data.terms;
        obligations.set(event.obligationId, { ...current, beneficiaryId, method, reason });
      }
    }
  }
  return obligations;
}

// ---- webhooks and reactions ----------------------------------------------------------------------------------------

/**
 * `WEBHOOK_RECEIVED`: one verified, first-seen Airwallex delivery, written in the same transaction as its dedupe row.
 * `claimedStatus` is what the event body said; it is never applied (the transfer is re-read), only kept for the record.
 */
export const WebhookReceivedSchema = z.looseObject({
  eventId: z.string(),
  name: z.string(),
  transferId: z.string().nullable(),
  createdAt: z.string(),
  claimedStatus: z.string().nullable().optional(),
  outcome: z.string().optional(),
});

const DecisionBriefSchema = z.object({ recommended: z.string(), severity: z.string(), allowed: z.array(z.string()) });
export type DecisionBrief = z.infer<typeof DecisionBriefSchema>;

/** One bank-side transfer change an `INCIDENT_REACTION` covers, pointing at the `TRANSFER_STATUS` event that recorded it. */
export const ReactionChangeSchema = z.object({
  statusSeq: z.number().int(),
  attemptId: z.string(),
  transferId: z.string(),
  from: z.string().nullable(),
  to: z.string(),
  failureCode: z.string().nullable(),
});
export type ReactionChange = z.infer<typeof ReactionChangeSchema>;

/** What made Tessera look: a verified webhook (named by its event id) or the background sweep. */
export const ReactionTriggerSchema = z.object({
  source: z.enum(["webhook", "sweep", "setup"]),
  eventId: z.string().nullable(),
  eventName: z.string().nullable(),
  eventCreatedAt: z.string().nullable(),
});
export type ReactionTrigger = z.infer<typeof ReactionTriggerSchema>;

/**
 * `INCIDENT_REACTION`: Tessera's answer to bank-side transfer changes on one incident. `before` is the Commander's
 * decision with the changes taken back, `after` with them applied, both computed at the same moment on the same
 * balances, so a difference is the bank event's doing and nothing else. `wake` says whether an agent was asked for.
 */
export const IncidentReactionSchema = z.object({
  changes: z.array(ReactionChangeSchema).min(1),
  trigger: ReactionTriggerSchema,
  before: DecisionBriefSchema,
  after: DecisionBriefSchema,
  decisionChanged: z.boolean(),
  wake: z.enum(["requested", "not_needed", "off", "suppressed"]),
});
export type IncidentReaction = z.infer<typeof IncidentReactionSchema>;

/** `AGENT_WAKE`: an event-driven agent run for one incident, started or refused by a cap, naming what woke it. */
export const AgentWakeSchema = z.object({
  outcome: z.enum(["started", "capped", "skipped"]),
  reactionSeqs: z.array(z.number().int()).min(1),
  eventIds: z.array(z.string()),
  eventNames: z.array(z.string()),
  actor: z.string(),
  detail: z.string().nullable(),
});
export type AgentWake = z.infer<typeof AgentWakeSchema>;

/**
 * `AGENT_WAKE_FINISHED`: how that run ended. `tools` lists each call as `name:outcome` (read-only calls leave no other
 * trace) and `report` keeps the agent's closing words, bounded, because nobody is watching a woken run's stream.
 * Both are absent on rows written before 2026-11-06.
 */
export const AgentWakeFinishedSchema = z.object({
  wakeSeq: z.number().int(),
  actor: z.string(),
  steps: z.number().int(),
  calls: z.number().int(),
  refused: z.number().int(),
  stoppedBecause: z.string(),
  tools: z.array(z.string()).optional(),
  report: z.string().nullable().optional(),
});

/** Bank-side changes are the ones a reaction covers: Airwallex moved a transfer Tessera already held. */
export const REACTABLE_VIA: Readonly<Record<string, true>> = { webhook: true, sync: true };

/** `TRANSFER_STATUS` seqs some `INCIDENT_REACTION` already covers. */
export function reactedStatusSeqs(events: LedgerEvent[]): Set<number> {
  const seqs = new Set<number>();
  for (const event of events) {
    if (event.type !== "INCIDENT_REACTION") continue;
    const p = IncidentReactionSchema.safeParse(event.payload);
    if (p.success) for (const change of p.data.changes) seqs.add(change.statusSeq);
  }
  return seqs;
}

/**
 * Replays reactions and wakes against the events they cite, for `verifyChain`. Each reaction must cover real, earlier
 * `TRANSFER_STATUS` events of its own incident, each at most once (a forged reaction cannot pre-empt a real one); each
 * wake must cite earlier reactions of its incident; each finish must close one started wake. Returns the first problem.
 */
export function replayReactions(events: LedgerEvent[]): string | null {
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  const covered = new Set<number>();
  const finished = new Set<number>();
  for (const event of events) {
    if (event.type === "INCIDENT_REACTION") {
      const p = IncidentReactionSchema.safeParse(event.payload);
      if (!p.success) return `reaction ${event.seq} is unreadable`;
      for (const change of p.data.changes) {
        const cited = bySeq.get(change.statusSeq);
        const status = cited?.type === "TRANSFER_STATUS" ? TransferStatusPayloadSchema.safeParse(cited.payload) : null;
        const matches =
          cited !== undefined && cited.seq < event.seq && cited.obligationId === event.obligationId && status?.success === true &&
          status.data.attemptId === change.attemptId && status.data.from === change.from && status.data.to === change.to;
        if (!matches) return `reaction ${event.seq} cites transfer change ${change.statusSeq}, which is not in the history as recorded`;
        if (covered.has(change.statusSeq)) return `transfer change ${change.statusSeq} is reacted to twice (again at ${event.seq})`;
        covered.add(change.statusSeq);
      }
      continue;
    }
    if (event.type === "AGENT_WAKE") {
      const p = AgentWakeSchema.safeParse(event.payload);
      if (!p.success) return `agent wake ${event.seq} is unreadable`;
      for (const seq of p.data.reactionSeqs) {
        const cited = bySeq.get(seq);
        if (cited?.type !== "INCIDENT_REACTION" || cited.seq > event.seq || cited.obligationId !== event.obligationId) {
          return `agent wake ${event.seq} cites reaction ${seq}, which is not in the history`;
        }
      }
      continue;
    }
    if (event.type === "AGENT_WAKE_FINISHED") {
      const p = AgentWakeFinishedSchema.safeParse(event.payload);
      const wake = p.success ? bySeq.get(p.data.wakeSeq) : undefined;
      const started = wake?.type === "AGENT_WAKE" && AgentWakeSchema.safeParse(wake.payload).data?.outcome === "started";
      if (!p.success || !started || wake.obligationId !== event.obligationId || wake.seq > event.seq || finished.has(wake.seq)) {
        return `agent wake finish ${event.seq} does not close a started wake of its incident`;
      }
      finished.add(wake.seq);
    }
  }
  return null;
}
