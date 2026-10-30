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
 * only back once Airwallex reaches CANCELLED. Approval statuses that never executed are LIVE until a person releases
 * them (`PayoutGateway.resolveAttempt`).
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

export interface ReplayedAttempt {
  state: AttemptState;
  transferId: string | null;
  awxStatus: string | null;
}

const AttemptRefSchema = z.looseObject({ attemptId: z.string() });
const ResolvedPayloadSchema = z.looseObject({
  attemptId: z.string(),
  to: z.enum(["INTENT", "LIVE", "PAID", "DEAD", "ABANDONED"]),
});

/**
 * Rebuilds every attempt's state from its own events, the way the gateway wrote them. A table row that disagrees
 * with this was edited outside the gateway.
 */
export function replayAttempts(events: LedgerEvent[]): Map<string, ReplayedAttempt> {
  const attempts = new Map<string, ReplayedAttempt>();
  for (const event of events) {
    if (event.type === "ATTEMPT_INTENT") {
      const ref = AttemptRefSchema.safeParse(event.payload);
      if (ref.success) attempts.set(ref.data.attemptId, { state: "INTENT", transferId: null, awxStatus: null });
      continue;
    }
    if (event.type === "TRANSFER_STATUS") {
      const p = TransferStatusPayloadSchema.safeParse(event.payload);
      const current = p.success ? attempts.get(p.data.attemptId) : undefined;
      if (!p.success || !current || current.state === "DEAD") continue;
      attempts.set(p.data.attemptId, { state: classifyStatus(p.data.to), transferId: p.data.transferId, awxStatus: p.data.to });
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
