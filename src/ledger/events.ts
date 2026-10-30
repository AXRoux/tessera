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
