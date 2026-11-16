import { z } from "zod";

/** A CARD_CHECKOUT event: an agent's checkout with a card, and what Visa's Trusted Agent Protocol said at the merchant. */
export const CardCheckoutPayloadSchema = z.looseObject({
  cardId: z.string(),
  actor: z.string(),
  /** The invoice paid, for an invoice card. */
  invoice: z.string().optional(),
  status: z.enum(["APPROVED", "DECLINED", "REJECTED"]),
  orderId: z.string().nullable(),
  reason: z.string().nullable(),
  tap: z.looseObject({ verified: z.boolean(), kid: z.string().optional() }),
});
export type CardCheckoutPayload = z.infer<typeof CardCheckoutPayloadSchema>;
