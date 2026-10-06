import { z } from "zod";
import type { LedgerEvent } from "./ledger";

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
