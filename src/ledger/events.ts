import { z } from "zod";

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
