import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { canonicalJson, sha256Hex } from "../canonical";

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
  failureCode: z.string().nullable(),
  expected: WalletLinesSchema.nullable(),
  actual: WalletLinesSchema.nullable(),
});

export const ClosureCertificateBodySchema = z.object({
  version: z.literal(1),
  obligationId: z.string(),
  reference: z.string(),
  currency: z.string(),
  amountMinor: z.number().int(),
  beneficiaryId: z.string(),
  settledAttemptId: z.string(),
  settledTransferId: z.string(),
  attempts: z.array(CertificateAttemptSchema),
  totals: TotalsSchema,
  /** Head of the event chain just before this certificate; anchors the whole history. */
  eventChainHead: z.string(),
  issuedAt: z.string(),
});
export type ClosureCertificateBody = z.infer<typeof ClosureCertificateBodySchema>;

export const SignedCertificateSchema = z.object({
  body: ClosureCertificateBodySchema,
  /** sha256 of the canonical body. This is the value to anchor on a chain. */
  hash: z.string(),
  signature: z.string(),
});
export type SignedCertificate = z.infer<typeof SignedCertificateSchema>;

export const signCertificateHash = (hash: string, secret: string): string =>
  createHmac("sha256", secret).update(`payonce-certificate-v1|${hash}`).digest("hex");

export function verifyCertificate(certificate: SignedCertificate, secret: string): boolean {
  if (sha256Hex(canonicalJson(certificate.body)) !== certificate.hash) return false;
  const expected = Buffer.from(signCertificateHash(certificate.hash, secret), "hex");
  const actual = Buffer.from(certificate.signature, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
