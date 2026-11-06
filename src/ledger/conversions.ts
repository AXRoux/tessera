/**
 * Funding conversions in the ledger: the row type, what an Airwallex conversion status means for the one-conversion lock,
 * and the replay `verifyChain` uses to prove the `conversions` table says what its events say.
 *
 * A conversion funds exactly one replacement: it is keyed to the DEAD attempt it pays for (`forAttemptId`). The lock is
 * a partial unique index over INTENT, BOOKED and SETTLED, so a settled conversion keeps it for good; only a conversion
 * Airwallex provably never booked (ABANDONED) or cancelled (CANCELLED, funds returned) frees the replacement for another.
 */
import { z } from "zod";
import type { LedgerEvent } from "./ledger";

/**
 * INTENT: written before the network call. BOOKED: Airwallex holds it but has not settled it (SCHEDULED, OVERDUE, or a
 * status Tessera does not know). SETTLED: the bought currency is in the wallet. CANCELLED: Airwallex cancelled it and
 * returned the funds. ABANDONED: Airwallex definitively refused the create, or the intent's quote expired with no
 * conversion behind it, so nothing was ever booked.
 */
export type ConversionState = "INTENT" | "BOOKED" | "SETTLED" | "CANCELLED" | "ABANDONED";
export const CONVERSION_STATES: readonly ConversionState[] = ["INTENT", "BOOKED", "SETTLED", "CANCELLED", "ABANDONED"];

/** The terms a funding approval was bound to, copied onto the row and into the FUNDING_INTENT event. */
export interface ConversionTerms {
  quoteId: string;
  currencyPair: string;
  buyCurrency: string;
  buyMinor: number;
  sellCurrency: string;
  sellMinor: number;
  /** Airwallex's client rate for `currencyPair`, as quoted. */
  rate: number;
  quoteValidTo: string;
}

export interface ConversionAttempt extends ConversionTerms {
  id: string;
  obligationId: string;
  /** The DEAD payout attempt whose replacement this conversion funds. */
  forAttemptId: string;
  requestId: string;
  state: ConversionState;
  conversionId: string | null;
  awxStatus: string | null;
  approvalNonce: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What an Airwallex conversion status means for the lock. Unknown statuses keep it, like an unknown transfer status. */
export function classifyConversion(status: string): Extract<ConversionState, "BOOKED" | "SETTLED" | "CANCELLED"> {
  if (status === "SETTLED") return "SETTLED";
  if (status === "CANCELLED") return "CANCELLED";
  return "BOOKED";
}

/** A conversion that holds the one-per-replacement lock. */
export const holdsFundingLock = (state: ConversionState): boolean => state === "INTENT" || state === "BOOKED" || state === "SETTLED";

const TermsSchema = z.object({
  quoteId: z.string(),
  currencyPair: z.string(),
  buyCurrency: z.string(),
  buyMinor: z.number(),
  sellCurrency: z.string(),
  sellMinor: z.number(),
  rate: z.number(),
  quoteValidTo: z.string(),
});
export const FundingIntentPayloadSchema = z.looseObject({
  fundingId: z.string(),
  forAttemptId: z.string(),
  requestId: z.string(),
  nonce: z.string(),
  terms: TermsSchema,
});
export const FundingStatusPayloadSchema = z.looseObject({
  fundingId: z.string(),
  conversionId: z.string(),
  from: z.string().nullable(),
  to: z.string(),
  via: z.string(),
});
const FundingRefSchema = z.looseObject({ fundingId: z.string() });

/** What a conversion's own events say about it. */
export interface ReplayedConversion {
  obligationId: string | null;
  forAttemptId: string;
  requestId: string;
  nonce: string;
  terms: ConversionTerms;
  state: ConversionState;
  conversionId: string | null;
  awxStatus: string | null;
}

/** Rebuilds every conversion from FUNDING_INTENT, FUNDING_STATUS and FUNDING_ABANDONED, the way the executor wrote them. */
export function replayConversions(events: LedgerEvent[]): Map<string, ReplayedConversion> {
  const conversions = new Map<string, ReplayedConversion>();
  for (const event of events) {
    if (event.type === "FUNDING_INTENT") {
      const p = FundingIntentPayloadSchema.safeParse(event.payload);
      if (!p.success) continue;
      conversions.set(p.data.fundingId, {
        obligationId: event.obligationId, forAttemptId: p.data.forAttemptId, requestId: p.data.requestId, nonce: p.data.nonce,
        terms: p.data.terms, state: "INTENT", conversionId: null, awxStatus: null,
      });
      continue;
    }
    if (event.type === "FUNDING_STATUS") {
      const p = FundingStatusPayloadSchema.safeParse(event.payload);
      const current = p.success ? conversions.get(p.data.fundingId) : undefined;
      if (!p.success || !current) continue;
      conversions.set(p.data.fundingId, { ...current, state: classifyConversion(p.data.to), conversionId: p.data.conversionId, awxStatus: p.data.to });
      continue;
    }
    if (event.type === "FUNDING_ABANDONED") {
      const ref = FundingRefSchema.safeParse(event.payload);
      const current = ref.success ? conversions.get(ref.data.fundingId) : undefined;
      if (ref.success && current) conversions.set(ref.data.fundingId, { ...current, state: "ABANDONED" });
    }
  }
  return conversions;
}

/** The first way a conversion row disagrees with what its own events say, or null. */
export function conversionMismatch(row: ConversionAttempt, r: ReplayedConversion): string | null {
  if (r.state !== row.state || r.conversionId !== row.conversionId || r.awxStatus !== row.awxStatus) {
    return `is ${row.state}/${row.awxStatus ?? "-"} in its table but ${r.state}/${r.awxStatus ?? "-"} by its events`;
  }
  const fields: Array<[string, unknown, unknown]> = [
    ["obligationId", row.obligationId, r.obligationId],
    ["forAttemptId", row.forAttemptId, r.forAttemptId],
    ["requestId", row.requestId, r.requestId],
    ["approvalNonce", row.approvalNonce, r.nonce],
    ...(Object.keys(r.terms) as Array<keyof ConversionTerms>).map((key): [string, unknown, unknown] => [key, row[key], r.terms[key]]),
  ];
  for (const [field, stored, expected] of fields) {
    if (stored !== expected) return `has ${field} ${String(stored)} in its table but ${String(expected)} by its intent`;
  }
  return null;
}
