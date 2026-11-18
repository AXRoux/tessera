/**
 * Paying a supplier invoice by Visa card, the Kit 03 way: the failed transfer stays the record, and the card is just
 * another rail under the same duplicate lock.
 *
 *   1. Code allows it. PAY_BY_CARD is offered only where a replacement transfer would be allowed (the original provably
 *      CANCELLED with the money back, a failure that may be replaced, the wallet covering it, nothing escalated).
 *   2. The card is asked for. Its terms are the invoice's (exact amount, currency, the supplier as the one merchant,
 *      single use), and writing it takes the invoice's lock in the database: no transfer can be attempted while it holds.
 *   3. A named person signs it (the card desk's own approval). An agent cannot.
 *   4. The agent pays the supplier's checkout through Visa's Trusted Agent Protocol: the request is signed with the agent's
 *      key over the invoice's own payment path, the payment container is signed and names the invoice, and the merchant
 *      verifies both before it charges. Airwallex applies the card's controls to the charge.
 *   5. The charge clears, is proved against the signed terms, holds through the hold window, and the Closer certifies the
 *      invoice with the card in the certificate, alongside what happened to every transfer.
 *
 * Steps 2 and 4 are one call: it does whichever the invoice is ready for, and nothing when it is ready for neither.
 */
import type { Commander } from "../commander/commander";
import type { SupplierEvidence } from "../commander/evidence";
import type { Decision } from "../commander/policy";
import type { CardRow } from "../ledger/cards";
import type { Ledger } from "../ledger/ledger";
import { formatMinor, fromMinor } from "../money";
import type { CheckoutResult } from "./merchant";
import type { CardDesk } from "./desk";

/** Code (the commander's policy, the card policy, or the merchant's TAP check) refused to pay this invoice by card. */
export class CardPaymentRefused extends Error {
  constructor(
    readonly obligationId: string,
    readonly reasons: string[],
  ) {
    super(`obligation ${obligationId}: ${reasons[0] ?? "paying by card is not allowed"}`);
    this.name = "CardPaymentRefused";
  }
}

export interface InvoiceCardResult {
  /** REQUESTED: a card now waits for a person's signature. PAID / DECLINED / REJECTED: the agent's checkout and its answer. */
  outcome: "REQUESTED" | "PAID" | "DECLINED" | "REJECTED";
  card: CardRow;
  checkout: CheckoutResult | null;
  next: string;
}

export interface InvoiceCardDeps {
  ledger: Ledger;
  commander: Commander;
  desk: CardDesk;
}

const refusals = (decision: Decision, action: "PAY_BY_CARD"): string[] => {
  const blocked = decision.blocked.filter((b) => b.action === action).map((b) => b.reason);
  return [
    ...(blocked.length > 0 ? blocked : [`PAY_BY_CARD is not among the allowed actions (${decision.allowed.join(", ") || "nothing"}).`]),
    ...decision.reasons,
  ];
};

/**
 * Moves an invoice one step along the card rail: asks for its card, or pays with the card a person signed. `actor` asks
 * for the card and signs the checkout's audit line (`agent:...` or a person's id; either way only a person can sign the
 * card itself).
 */
export async function payInvoiceByCard(
  deps: InvoiceCardDeps,
  obligationId: string,
  input: { actor: string; reason: string; evidence: SupplierEvidence | null },
): Promise<InvoiceCardResult> {
  const { ledger, commander, desk } = deps;
  const { decision } = await commander.assess(obligationId, input.evidence);
  if (!decision.allowed.includes("PAY_BY_CARD")) throw new CardPaymentRefused(obligationId, refusals(decision, "PAY_BY_CARD"));
  const obligation = ledger.requireObligation(obligationId);
  const held = ledger.invoiceCard(obligationId);

  if (!held) {
    const card = await desk.requestForInvoice(obligation, input.actor, input.reason);
    if (card.state === "REFUSED") throw new CardPaymentRefused(obligationId, [`the card policy refused the card: ${card.lastError ?? "no reason given"}`]);
    return {
      outcome: "REQUESTED", card, checkout: null,
      next: `A single-use Visa card for exactly ${formatMinor(card.amountMinor, card.currency)}, payable only to ${card.merchant}, waits for an authorized individual to sign it. Once it is ACTIVE, call this again to pay.`,
    };
  }

  // PAY_BY_CARD is allowed with a card only while that card is ACTIVE and unused: pay the invoice, the whole of it.
  const { card, result } = await desk.agentCheckout(held.id, { amount: fromMinor(obligation.amountMinor, obligation.currency), merchant: held.merchant }, input.actor);
  ledger.refreshObligationStatus(obligationId);
  const outcome = result.status === "APPROVED" ? "PAID" : result.status;
  return {
    outcome, card, checkout: result,
    next:
      outcome === "PAID"
        ? "The supplier charged the card. Once the charge has cleared and held through the hold window, assess again and reconcile_and_close."
        : `The checkout did not go through (${result.reason ?? "no reason given"}). Assess again: after repeated failures the code hands it to a person.`,
  };
}
