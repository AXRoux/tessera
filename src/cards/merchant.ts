/**
 * A sandbox merchant that only takes payment from a trusted agent: it verifies Visa's Trusted Agent Protocol on every
 * checkout before it charges anything.
 *
 * The checkout request must carry a TAP message signature tagged `agent-payer-auth`, and its body an agentic payment
 * container signed with the same key and carrying the same nonce (TAP, "Payment"). Only then does the merchant charge
 * the card, through Airwallex's sandbox simulator (or the offline fake), and Airwallex applies the card's own controls.
 * The card number never travels: the container carries a payment token (the Airwallex card id) and its last four.
 */
import type { KeyObject } from "node:crypto";
import { z } from "zod";
import type { CardChargeSimulator } from "../airwallex/issuing";
import { TapVerifier, verifyObject, type TapVerdict } from "./tap";

export const SANDBOX_MERCHANT_ORIGIN = "https://merchant.sandbox.tessera.dev";

const CheckoutBodySchema = z.object({
  order: z.object({
    merchant: z.string().min(1).max(80),
    description: z.string().max(200),
    amount: z.number().positive(),
    currency: z.string().length(3),
    merchantCategoryCode: z.string().regex(/^\d{4}$/),
  }),
  agenticPaymentContainer: z.looseObject({
    nonce: z.string(),
    kid: z.string(),
    alg: z.string(),
    paymentToken: z.string(),
    lastFour: z.string().nullable(),
    signature: z.string(),
  }),
});
export type CheckoutBody = z.infer<typeof CheckoutBodySchema>;

export interface CheckoutResult {
  orderId: string | null;
  status: "APPROVED" | "DECLINED" | "REJECTED";
  /** Airwallex's decline reason, or why the merchant would not even try. */
  reason: string | null;
  tap: TapVerdict;
}

export class SandboxMerchant {
  private readonly verifier: TapVerifier;

  constructor(
    private readonly deps: { keys: (kid: string) => KeyObject | null; charger: CardChargeSimulator; now?: () => number },
  ) {
    this.verifier = new TapVerifier(deps.keys, deps.now);
  }

  async checkout(request: Request): Promise<CheckoutResult> {
    const tap = this.verifier.verify(request, "agent-payer-auth");
    if (!tap.ok) return { orderId: null, status: "REJECTED", reason: tap.reason, tap };
    const raw = (await request.json().catch(() => null)) as { agenticPaymentContainer?: Record<string, unknown> } | null;
    const parsed = CheckoutBodySchema.safeParse(raw);
    if (!parsed.success || !raw?.agenticPaymentContainer) return { orderId: null, status: "REJECTED", reason: "the checkout body is malformed", tap };
    const { order, agenticPaymentContainer: container } = parsed.data;
    // The container is linked to the signed request by its nonce and key, and signed by that same key.
    if (container.nonce !== tap.nonce || container.kid !== tap.kid) {
      return { orderId: null, status: "REJECTED", reason: "the payment container is not linked to the signed request", tap };
    }
    const key = this.deps.keys(container.kid);
    // Verified as received, field order and all: a parser that reorders fields would break the signature base.
    if (!key || !verifyObject(raw.agenticPaymentContainer, key)) return { orderId: null, status: "REJECTED", reason: "the payment container signature does not verify", tap };
    const charge = await this.deps.charger.charge({
      cardId: container.paymentToken,
      amount: order.amount,
      currency: order.currency,
      merchantCategoryCode: order.merchantCategoryCode,
      merchantName: order.merchant,
    });
    const approved = charge.process_result === "APPROVED";
    return {
      orderId: approved ? `ORD-${crypto.randomUUID().slice(0, 8).toUpperCase()}` : null,
      status: approved ? "APPROVED" : "DECLINED",
      reason: approved ? null : (charge.failure_reason ?? "declined"),
      tap,
    };
  }
}
