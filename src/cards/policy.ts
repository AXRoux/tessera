/**
 * What a Visa virtual card may be, in code. A request is checked here before any person sees it, and the same limits
 * become the card's own controls at Airwallex, so the network refuses what this file refuses.
 *
 * The categories are Visa merchant category codes (MCCs) grouped the way a finance team thinks about spend. A card may
 * only be charged at merchants in its category: a SaaS card cannot buy flights.
 */
import { formatMinor } from "../money";
import type { CardTerms } from "../ledger/cards";

export interface CardCategory {
  label: string;
  /** Visa merchant category codes. The first is what a merchant in this category charges as, in the sandbox. */
  mccs: string[];
}

export const CARD_CATEGORIES: Readonly<Record<string, CardCategory>> = {
  software: { label: "Software and SaaS", mccs: ["5734", "5817", "5818", "7372"] },
  cloud: { label: "Cloud and hosting", mccs: ["4816", "7379", "7399"] },
  advertising: { label: "Advertising", mccs: ["7311"] },
  travel: { label: "Travel", mccs: ["4511", "7011", "4722"] },
  office: { label: "Office supplies", mccs: ["5111", "5943", "5044"] },
};

export interface CardPolicy {
  /** The most one card may carry, per currency, in minor units. A currency missing here cannot have cards. */
  maxPerCardMinor: Readonly<Record<string, number>>;
  /** The most an agent may ask for on one card. A person can ask for up to the card maximum. */
  agentMaxMinor: Readonly<Record<string, number>>;
  /** The most all cards asked for in one UTC day may carry together, per currency. */
  dailyMinor: Readonly<Record<string, number>>;
  /** Cards that may be live (pending, issuing, active or frozen) at once. */
  maxLive: number;
  /** Days a card stays usable after it is issued. */
  lifetimeDays: number;
  /** Shortest reason a request may give. */
  minReasonChars: number;
}

export const DEFAULT_CARD_POLICY: CardPolicy = {
  maxPerCardMinor: { USD: 250_000, EUR: 250_000, GBP: 200_000 },
  agentMaxMinor: { USD: 100_000, EUR: 100_000, GBP: 80_000 },
  dailyMinor: { USD: 1_000_000, EUR: 1_000_000, GBP: 800_000 },
  maxLive: 12,
  lifetimeDays: 7,
  minReasonChars: 12,
};

export interface CardRequestContext {
  /** Whether an agent (rather than a person) is asking. */
  byAgent: boolean;
  /** Minor units already asked for today in this currency, refused requests excluded. */
  requestedTodayMinor: number;
  /** Cards pending, issuing, active or frozen right now. */
  liveCards: number;
  /** Available balance of the currency's wallet less its reserve floor, or null when balances could not be read. */
  spendableMinor: number | null;
}

/** Why a card request is refused, in a person's words; empty when code allows it. */
export function checkCardRequest(terms: Pick<CardTerms, "amountMinor" | "currency" | "category" | "merchant" | "purpose">, reason: string, ctx: CardRequestContext, policy: CardPolicy = DEFAULT_CARD_POLICY): string[] {
  const reasons: string[] = [];
  const max = policy.maxPerCardMinor[terms.currency];
  if (max === undefined) {
    reasons.push(`cards are not issued in ${terms.currency}; ${Object.keys(policy.maxPerCardMinor).join(", ")} only`);
    return reasons;
  }
  if (!CARD_CATEGORIES[terms.category]) reasons.push(`"${terms.category}" is not a card category`);
  if (terms.merchant.trim().length < 2) reasons.push("name the merchant the card is for");
  if (terms.purpose.trim().length < 3) reasons.push("say what the card is for");
  if (reason.trim().length < policy.minReasonChars) reasons.push(`give a reason of at least ${policy.minReasonChars} characters`);
  if (terms.amountMinor <= 0) reasons.push("the amount must be above zero");
  if (terms.amountMinor > max) reasons.push(`${formatMinor(terms.amountMinor, terms.currency)} is above the card limit of ${formatMinor(max, terms.currency)}`);
  const agentMax = policy.agentMaxMinor[terms.currency] ?? 0;
  if (ctx.byAgent && terms.amountMinor > agentMax) {
    reasons.push(`an agent may ask for at most ${formatMinor(agentMax, terms.currency)} on one card; a person can ask for more`);
  }
  const daily = policy.dailyMinor[terms.currency] ?? 0;
  if (ctx.requestedTodayMinor + terms.amountMinor > daily) {
    reasons.push(`today's cards would carry ${formatMinor(ctx.requestedTodayMinor + terms.amountMinor, terms.currency)}, above the daily ${formatMinor(daily, terms.currency)}`);
  }
  if (ctx.liveCards >= policy.maxLive) reasons.push(`${ctx.liveCards} cards are already live; close one first`);
  if (ctx.spendableMinor !== null && terms.amountMinor > ctx.spendableMinor) {
    reasons.push(`the ${terms.currency} wallet has ${formatMinor(Math.max(0, ctx.spendableMinor), terms.currency)} above its reserve floor`);
  }
  return reasons;
}
