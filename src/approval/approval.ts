import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../canonical";
import { ApprovalRejected } from "../errors";

/**
 * Everything the approver saw. The gateway re-derives the payment from this payload, so an approval for
 * "pay 100 USD to beneficiary A" cannot be replayed as 101 USD, another beneficiary, or a second time.
 */
export const ApprovalPayloadSchema = z.object({
  obligationId: z.string().min(1),
  amountMinor: z.number().int().positive(),
  currency: z.string().length(3),
  beneficiaryId: z.string().min(1),
  method: z.enum(["LOCAL", "SWIFT"]),
  reason: z.string().min(1),
  /** null for the first attempt; otherwise the failed attempt being replaced. */
  replacesAttemptId: z.string().nullable(),
  /** sha256 of the evidence bundle the approver reviewed. */
  evidenceHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** POLICY: code-granted. HUMAN: a named person; a note of 10+ characters unlocks AFTER_CHANGE and FORBIDDEN replacements. */
  mode: z.enum(["POLICY", "HUMAN"]),
  approver: z.string().min(1),
  note: z.string().optional(),
  expiresAt: z.iso.datetime(),
  nonce: z.string().min(16),
});
export type ApprovalPayload = z.infer<typeof ApprovalPayloadSchema>;

export interface Approval {
  payload: ApprovalPayload;
  mac: string;
}

export const newNonce = (): string => randomBytes(16).toString("hex");

const macOf = (payload: ApprovalPayload, secret: string): string =>
  createHmac("sha256", secret).update(canonicalJson(payload)).digest("hex");

export function issueApproval(payload: ApprovalPayload, secret: string): Approval {
  return { payload: ApprovalPayloadSchema.parse(payload), mac: macOf(payload, secret) };
}

export function verifyApproval(approval: Approval, secret: string, now: Date): ApprovalPayload {
  const parsed = ApprovalPayloadSchema.safeParse(approval.payload);
  if (!parsed.success) throw new ApprovalRejected("malformed", parsed.error.message);

  const expected = Buffer.from(macOf(parsed.data, secret), "hex");
  const actual = Buffer.from(typeof approval.mac === "string" ? approval.mac : "", "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new ApprovalRejected("bad_signature", "MAC does not match payload");
  }
  if (Date.parse(parsed.data.expiresAt) <= now.getTime()) {
    throw new ApprovalRejected("expired", `expired at ${parsed.data.expiresAt}`);
  }
  return parsed.data;
}
