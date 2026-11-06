import { z } from "zod";

/** Signed minor-unit effects on the wallet: payouts and fees are negative, reversals positive. */
export const WalletLinesSchema = z.object({
  payoutMinor: z.number().int(),
  feeMinor: z.number().int(),
  reversalMinor: z.number().int(),
});
export type WalletLines = z.infer<typeof WalletLinesSchema>;

export const AttemptStateSchema = z.enum(["INTENT", "LIVE", "PAID", "DEAD", "ABANDONED"]);

/** What really happened to the wallet, from Airwallex's own lines. `paidMinor` must equal the amount owed. */
export const TotalsSchema = z.object({
  paidMinor: z.number().int(),
  feesMinor: z.number().int(),
  refundedMinor: z.number().int(),
  netWalletMinor: z.number().int(),
});
export type Totals = z.infer<typeof TotalsSchema>;

const CertificateAttemptSchema = z.object({
  seq: z.number().int(),
  attemptId: z.string(),
  requestId: z.string(),
  transferId: z.string().nullable(),
  state: AttemptStateSchema,
  /** Airwallex's status at close (version 2 on). */
  awxStatus: z.string().nullable().optional(),
  failureCode: z.string().nullable(),
  expected: WalletLinesSchema.nullable(),
  actual: WalletLinesSchema.nullable(),
});

/**
 * One funding conversion as the Closer found it (version 3 on): both legs as planned and as Airwallex booked them in
 * its wallet lines (CONVERSION_BUY and CONVERSION_SELL, keyed by the conversion id), and the quote they were bound to.
 */
export const CertificateFundingSchema = z.object({
  fundingId: z.string(),
  conversionId: z.string().nullable(),
  requestId: z.string(),
  quoteId: z.string(),
  forAttemptId: z.string(),
  state: z.enum(["INTENT", "BOOKED", "SETTLED", "CANCELLED", "ABANDONED"]),
  currencyPair: z.string(),
  rate: z.number(),
  buyCurrency: z.string(),
  sellCurrency: z.string(),
  expected: z.object({ buyMinor: z.number().int(), sellMinor: z.number().int() }),
  actual: z.object({ buyMinor: z.number().int(), sellMinor: z.number().int() }).nullable(),
});
export type CertificateFunding = z.infer<typeof CertificateFundingSchema>;

/**
 * Version 2 adds the Airwallex status of every attempt and of the settled transfer; version 3 adds the conversions that
 * funded a replacement. Version 1 and 2 certificates still verify.
 */
export const ClosureCertificateBodySchema = z.object({
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  obligationId: z.string(),
  reference: z.string(),
  currency: z.string(),
  amountMinor: z.number().int(),
  beneficiaryId: z.string(),
  settledAttemptId: z.string(),
  settledTransferId: z.string(),
  /** Re-read from Airwallex inside the close: a certificate is only issued while the transfer is PAID there. */
  settledAwxStatus: z.literal("PAID").optional(),
  attempts: z.array(CertificateAttemptSchema),
  totals: TotalsSchema,
  /** Version 3: every conversion made for this invoice, reconciled leg by leg. Totals stay in the invoice's currency. */
  funding: z.array(CertificateFundingSchema).optional(),
  /** Head of the event chain just before this certificate; pins the whole history to it. */
  eventChainHead: z.string(),
  issuedAt: z.string(),
});
export type ClosureCertificateBody = z.infer<typeof ClosureCertificateBodySchema>;

export const SignedCertificateSchema = z.object({
  body: ClosureCertificateBodySchema,
  /** sha256 of the canonical body: changing any field changes the hash. */
  hash: z.string(),
  signature: z.string(),
});
export type SignedCertificate = z.infer<typeof SignedCertificateSchema>;
