/**
 * Visa virtual cards in the ledger: the row type, the events every change writes, and the replay `verifyChain` uses to
 * prove the `cards` table says what its events say.
 *
 * A card is asked for (by a person or an agent), checked by code, signed by a person, then cut at Airwallex with the
 * signed terms as its controls. Its life is one line of events, hash-chained with everything else:
 *
 *   CARD_REQUESTED -> CARD_REFUSED                                  (code said no)        REFUSED
 *                  -> CARD_DECIDED(DECLINED)                        (a person said no)    DECLINED
 *                  -> CARD_DECIDED(APPROVED), CARD_ISSUE_INTENT     (before the call)     ISSUING
 *                       -> CARD_ISSUED                                                    ACTIVE
 *                       -> CARD_ISSUE_FAILED                        (Airwallex said no)   FAILED
 *   CARD_CHARGE      every merchant charge or decline Airwallex reports, and again each time Airwallex moves it
 *                    (a clearing is reported PENDING until it posts, then APPROVED, under the same id)
 *   CARD_STATUS      frozen, unfrozen, spent (a single-use card after its charge), closed
 *   CARD_SETTLED     an accepted charge proved against the terms a person signed: merchant, cap, category, currency,
 *                    single use. Once per charge, at its CLEARING; the purchase's receipt.
 */
import { z } from "zod";
import type { LedgerEvent } from "./ledger";

export type CardState = "PENDING" | "REFUSED" | "DECLINED" | "ISSUING" | "ACTIVE" | "FAILED" | "FROZEN" | "SPENT" | "CLOSED";
export const CARD_STATES: readonly CardState[] = ["PENDING", "REFUSED", "DECLINED", "ISSUING", "ACTIVE", "FAILED", "FROZEN", "SPENT", "CLOSED"];

/** The terms a person signs, copied onto the row, into CARD_REQUESTED, and (at issue) into the card's own controls. */
export interface CardTerms {
  /** What the card is for, in the requester's words: "Figma, two editor seats". */
  purpose: string;
  /** Who may charge it, as a person names them. */
  merchant: string;
  /** A category preset (src/cards/policy.ts); its merchant category codes become the card's allowlist. */
  category: string;
  /** The Visa merchant category codes the card accepts. */
  mccs: string[];
  amountMinor: number;
  currency: string;
  singleUse: boolean;
  /** ISO 8601: the card refuses everything after it. */
  activeTo: string;
}

export interface CardRow extends CardTerms {
  id: string;
  state: CardState;
  /** `operator:<name>` style actor for a person, `agent:<name>` for an agent. */
  requestedBy: string;
  reason: string;
  approvedBy: string | null;
  /** The request_id of the latest issue attempt: a lost reply is matched by the nickname, a retry gets a new one. */
  requestId: string;
  awxCardId: string | null;
  last4: string | null;
  brand: string | null;
  awxStatus: string | null;
  /** What approved, cleared charges have taken, in minor units. */
  spentMinor: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One charge (or decline) on a card, as Airwallex reported it. The transaction id is the dedupe key. */
export interface CardCharge {
  transactionId: string;
  cardId: string;
  type: string;
  status: string;
  amountMinor: number;
  currency: string;
  merchant: string | null;
  mcc: string | null;
  failureReason: string | null;
  at: string;
}

/**
 * Airwallex's words for a clearing that has gone through. A purchase is a CLEARING transaction, and the REST read
 * reports it PENDING until it posts in a batch (about half an hour on the sandbox), then APPROVED; the MCP read says
 * CLEARED. Airwallex's builder guide says to treat the CLEARING itself as accepted and not to wait for APPROVED, so
 * Tessera does: spent and proved at once, "settling" until Airwallex posts it.
 */
const THROUGH: ReadonlySet<string> = new Set(["PENDING", "APPROVED", "CLEARED"]);
const POSTED: ReadonlySet<string> = new Set(["APPROVED", "CLEARED"]);

/**
 * What a charge has taken from the card, in minor units: an accepted clearing takes its amount, a posted refund gives it
 * back, and a decline or a bare authorisation takes nothing. Airwallex reports a purchase as a negative amount, so the
 * sign comes from the type, never the amount.
 */
export function chargeTakesMinor(charge: Pick<CardCharge, "type" | "status" | "amountMinor">): number {
  if (charge.type === "CLEARING" && THROUGH.has(charge.status)) return Math.abs(charge.amountMinor);
  if (charge.type === "REFUND" && POSTED.has(charge.status)) return -Math.abs(charge.amountMinor);
  return 0;
}

/** Accepted, but not yet posted to the wallet at Airwallex. */
export const chargeSettling = (charge: Pick<CardCharge, "type" | "status">): boolean => charge.type === "CLEARING" && charge.status === "PENDING";

/**
 * What Airwallex holds on a card for authorisations that have not cleared (a two-phase charge before its capture).
 * Once the card has a clearing, the authorisation is that clearing's, so nothing more is held.
 */
export function heldFrom(charges: readonly Pick<CardCharge, "type" | "status" | "amountMinor">[]): number {
  if (charges.some((c) => chargeTakesMinor(c) > 0)) return 0;
  return charges.filter((c) => c.type === "AUTHORIZATION" && THROUGH.has(c.status)).reduce((sum, c) => sum + Math.abs(c.amountMinor), 0);
}

/** What a card has spent, from the latest word on each of its charges. */
export const spentFrom = (charges: Iterable<Pick<CardCharge, "type" | "status" | "amountMinor">>): number => {
  let total = 0;
  for (const charge of charges) total += chargeTakesMinor(charge);
  return total;
};

/** One check of a cleared charge against the signed terms. */
export interface SettlementCheck {
  check: "merchant" | "cap" | "category" | "currency" | "single_use" | "signed";
  ok: boolean;
  detail: string;
}

/** A cleared charge, proved against what a person signed. Written once per charge as CARD_SETTLED. */
export interface CardSettlement {
  cardId: string;
  transactionId: string;
  amountMinor: number;
  currency: string;
  merchant: string | null;
  mcc: string | null;
  checks: SettlementCheck[];
  /** Every check passed: the money went where the person said, for no more than they said. */
  matches: boolean;
}

const TermsSchema = z.object({
  purpose: z.string(),
  merchant: z.string(),
  category: z.string(),
  mccs: z.array(z.string()),
  amountMinor: z.number().int(),
  currency: z.string(),
  singleUse: z.boolean(),
  activeTo: z.string(),
});
export const CardRequestedSchema = TermsSchema.extend({ cardId: z.string(), requestId: z.string(), requestedBy: z.string(), reason: z.string() });
export const CardRefusedSchema = z.object({ cardId: z.string(), reasons: z.array(z.string()) });
export const CardDecidedSchema = z.object({ cardId: z.string(), decision: z.enum(["APPROVED", "DECLINED"]), by: z.string(), note: z.string() });
export const CardIssueIntentSchema = z.object({ cardId: z.string(), requestId: z.string(), cardholderId: z.string() });
export const CardIssuedSchema = z.object({ cardId: z.string(), awxCardId: z.string(), last4: z.string().nullable(), brand: z.string().nullable(), awxStatus: z.string() });
export const CardIssueFailedSchema = z.object({ cardId: z.string(), code: z.string(), message: z.string() });
export const CardChargeSchema = z.object({
  cardId: z.string(),
  transactionId: z.string(),
  type: z.string(),
  status: z.string(),
  amountMinor: z.number().int(),
  currency: z.string(),
  merchant: z.string().nullable(),
  mcc: z.string().nullable(),
  failureReason: z.string().nullable(),
});
export const CardSettledSchema = z.object({
  cardId: z.string(),
  transactionId: z.string(),
  amountMinor: z.number().int(),
  currency: z.string(),
  merchant: z.string().nullable(),
  mcc: z.string().nullable(),
  checks: z.array(z.object({ check: z.enum(["merchant", "cap", "category", "currency", "single_use", "signed"]), ok: z.boolean(), detail: z.string() })),
  matches: z.boolean(),
});
export const CardStatusSchema = z.object({
  cardId: z.string(),
  from: z.string(),
  to: z.enum(["ACTIVE", "FROZEN", "SPENT", "CLOSED"]),
  by: z.string(),
  why: z.string(),
  awxStatus: z.string().nullable(),
});

export interface ReplayedCard {
  state: CardState;
  terms: CardTerms;
  requestId: string;
  awxCardId: string | null;
  spentMinor: number;
}

/** Every card's state as its own events say it is. */
export function replayCards(events: LedgerEvent[]): Map<string, ReplayedCard> {
  const cards = new Map<string, ReplayedCard>();
  // The latest word on each charge, per card: a charge is reported again when Airwallex moves it.
  const charges = new Map<string, Map<string, z.infer<typeof CardChargeSchema>>>();
  for (const event of events) {
    if (!event.type.startsWith("CARD_")) continue;
    if (event.type === "CARD_REQUESTED") {
      const p = CardRequestedSchema.safeParse(event.payload);
      if (!p.success) continue;
      const { cardId, requestId, requestedBy: _by, reason: _reason, ...terms } = p.data;
      cards.set(cardId, { state: "PENDING", terms, requestId, awxCardId: null, spentMinor: 0 });
      continue;
    }
    const cardId = z.object({ cardId: z.string() }).safeParse(event.payload).data?.cardId;
    const card = cardId ? cards.get(cardId) : undefined;
    if (!card) continue;
    switch (event.type) {
      case "CARD_REFUSED":
        card.state = "REFUSED";
        break;
      case "CARD_DECIDED": {
        const p = CardDecidedSchema.safeParse(event.payload);
        if (p.success && p.data.decision === "DECLINED") card.state = "DECLINED";
        break;
      }
      case "CARD_ISSUE_INTENT": {
        const p = CardIssueIntentSchema.safeParse(event.payload);
        if (p.success) {
          card.state = "ISSUING";
          card.requestId = p.data.requestId;
        }
        break;
      }
      case "CARD_ISSUED": {
        const p = CardIssuedSchema.safeParse(event.payload);
        if (p.success) {
          card.state = "ACTIVE";
          card.awxCardId = p.data.awxCardId;
        }
        break;
      }
      case "CARD_ISSUE_FAILED":
        card.state = "FAILED";
        break;
      case "CARD_CHARGE": {
        const p = CardChargeSchema.safeParse(event.payload);
        if (p.success) {
          const own = charges.get(p.data.cardId) ?? new Map();
          own.set(p.data.transactionId, p.data);
          charges.set(p.data.cardId, own);
          card.spentMinor = spentFrom(own.values());
        }
        break;
      }
      case "CARD_STATUS": {
        const p = CardStatusSchema.safeParse(event.payload);
        if (p.success) card.state = p.data.to;
        break;
      }
    }
  }
  return cards;
}

/** The first way a card row disagrees with what its own events say, or null. */
export function cardMismatch(row: CardRow, replayed: ReplayedCard): string | null {
  if (row.state !== replayed.state) return `is ${row.state} in its table but ${replayed.state} by its events`;
  if (row.awxCardId !== replayed.awxCardId) return `names Airwallex card ${row.awxCardId ?? "none"} in its table but ${replayed.awxCardId ?? "none"} by its events`;
  if (row.spentMinor !== replayed.spentMinor) return `has spent ${row.spentMinor} in its table but ${replayed.spentMinor} by its events`;
  if (row.requestId !== replayed.requestId) return `has request ${row.requestId} in its table but ${replayed.requestId} by its events`;
  const terms = replayed.terms;
  for (const field of ["purpose", "merchant", "category", "amountMinor", "currency", "singleUse", "activeTo"] as const) {
    if (row[field] !== terms[field]) return `has ${field} ${String(row[field])} in its table but ${String(terms[field])} by its events`;
  }
  if (row.mccs.join(",") !== terms.mccs.join(",")) return "has other merchant categories in its table than by its events";
  return null;
}
