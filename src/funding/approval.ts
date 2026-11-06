/**
 * Approvals for funding conversions. Separate from payout approvals on purpose: a different payload, a different MAC
 * domain (`tessera-funding-v1|`), so a signed conversion can never be replayed as a payout or the other way round.
 *
 * An approval is bound to everything the approver (the policy, or a named person) saw: the incident and the failed attempt
 * whose replacement it funds, the quote (id, pair, both amounts, rate, expiry) and the assessment's evidence hash. Change
 * any of them and the MAC no longer matches; the executor then checks the quote and the wallets again before booking.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../canonical";
import { ApprovalRejected } from "../errors";

export const FundingApprovalPayloadSchema = z.object({
  kind: z.literal("FUNDING"),
  obligationId: z.string().min(1),
  /** The DEAD attempt whose replacement the conversion pays for. One conversion per replacement. */
  forAttemptId: z.string().min(1),
  quoteId: z.string().min(1),
  currencyPair: z.string().min(6),
  buyCurrency: z.string().length(3),
  buyMinor: z.number().int().positive(),
  sellCurrency: z.string().length(3),
  sellMinor: z.number().int().positive(),
  /** Airwallex's client rate for `currencyPair`, as quoted. */
  rate: z.number().positive(),
  quoteValidTo: z.iso.datetime(),
  /** sha256 of the assessment the approver reviewed (`Commander.assess`). */
  evidenceHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** POLICY: within the automatic conversion limit, granted by code. HUMAN: a named person with a written note. */
  mode: z.enum(["POLICY", "HUMAN"]),
  approver: z.string().min(1),
  note: z.string().optional(),
  expiresAt: z.iso.datetime(),
  nonce: z.string().min(16),
});
export type FundingApprovalPayload = z.infer<typeof FundingApprovalPayloadSchema>;

export interface FundingApproval {
  payload: FundingApprovalPayload;
  mac: string;
}

const macOf = (payload: FundingApprovalPayload, secret: string): string =>
  createHmac("sha256", secret).update(`tessera-funding-v1|${canonicalJson(payload)}`).digest("hex");

export function issueFundingApproval(payload: FundingApprovalPayload, secret: string): FundingApproval {
  const parsed = FundingApprovalPayloadSchema.parse(payload);
  return { payload: parsed, mac: macOf(parsed, secret) };
}

export function verifyFundingApproval(approval: FundingApproval, secret: string, now: Date): FundingApprovalPayload {
  const parsed = FundingApprovalPayloadSchema.safeParse(approval.payload);
  if (!parsed.success) throw new ApprovalRejected("malformed", parsed.error.message);
  const expected = Buffer.from(macOf(parsed.data, secret), "hex");
  const actual = Buffer.from(typeof approval.mac === "string" ? approval.mac : "", "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new ApprovalRejected("bad_signature", "MAC does not match payload");
  }
  if (Date.parse(parsed.data.expiresAt) <= now.getTime()) throw new ApprovalRejected("expired", `expired at ${parsed.data.expiresAt}`);
  return parsed.data;
}
