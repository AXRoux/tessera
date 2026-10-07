/**
 * The wire contract between the Tessera API and its clients. Pure zod: no database, no Bun, so the Next.js server
 * imports these schemas to parse every API response instead of trusting hand-copied types.
 */
import { z } from "zod";
import { AttemptStateSchema, SignedCertificateSchema } from "../closer/certificate";
import { ACTION_KINDS, SEVERITIES } from "../commander/actions";
import { DraftRecordedSchema } from "../commander/drafts";
import { EvidenceRecordedSchema } from "../commander/evidence";

const Method = z.enum(["LOCAL", "SWIFT"]);

export const ObligationSchema = z.object({
  id: z.string(),
  reference: z.string(),
  beneficiaryId: z.string(),
  amountMinor: z.number().int(),
  currency: z.string(),
  method: Method,
  reason: z.string(),
  status: z.enum(["OPEN", "PAYING", "PAID", "NEEDS_ACTION", "ESCALATED", "CLOSED"]),
  escalationReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const AttemptSchema = z.object({
  id: z.string(),
  obligationId: z.string(),
  seq: z.number().int(),
  requestId: z.string(),
  beneficiaryId: z.string(),
  amountMinor: z.number().int(),
  currency: z.string(),
  method: Method,
  reason: z.string(),
  state: AttemptStateSchema,
  transferId: z.string().nullable(),
  awxStatus: z.string().nullable(),
  failureCode: z.string().nullable(),
  failureMessage: z.string().nullable(),
  feeMinor: z.number().int().nullable(),
  payerPaysMinor: z.number().int().nullable(),
  approvalNonce: z.string(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const LedgerEventSchema = z.object({
  seq: z.number().int(),
  obligationId: z.string().nullable(),
  type: z.string(),
  payload: z.unknown(),
  ts: z.string(),
  prevHash: z.string(),
  hash: z.string(),
});

const Action = z.enum(ACTION_KINDS);

export const DecisionSchema = z.object({
  recommended: Action,
  allowed: z.array(Action),
  blocked: z.array(z.object({ action: Action, reason: z.string() })),
  reasons: z.array(z.string()),
  severity: z.enum(SEVERITIES),
  recheckAt: z.string().nullable(),
  replacement: z
    .object({
      failureClass: z.string(),
      policy: z.string(),
      needsChange: z.string().nullable(),
      autoApprovable: z.boolean(),
    })
    .nullable(),
});

export const RecordedEvidenceSchema = EvidenceRecordedSchema.extend({ at: z.string() });

export const IncidentSummarySchema = z.object({
  id: z.string(),
  reference: z.string(),
  amountMinor: z.number().int(),
  currency: z.string(),
  method: Method,
  status: ObligationSchema.shape.status,
  attemptCount: z.number().int(),
  latest: z
    .object({ seq: z.number().int(), state: AttemptStateSchema, awxStatus: z.string().nullable(), failureCode: z.string().nullable() })
    .nullable(),
  updatedAt: z.string(),
});
export type IncidentSummary = z.infer<typeof IncidentSummarySchema>;

export const IncidentListSchema = z.object({ items: z.array(IncidentSummarySchema) });

export const PendingDraftSchema = DraftRecordedSchema.extend({ seq: z.number().int(), at: z.string() });

export const IncidentViewSchema = z.object({
  obligation: ObligationSchema,
  attempts: z.array(AttemptSchema),
  events: z.array(LedgerEventSchema),
  evidence: RecordedEvidenceSchema.nullable(),
  /** A supplier reply an agent drafted that no person has dealt with yet. */
  draft: PendingDraftSchema.nullable(),
  assessment: z.object({ decision: DecisionSchema, evidenceHash: z.string() }).nullable(),
  assessmentError: z.string().nullable(),
  certificate: SignedCertificateSchema.nullable(),
  chain: z.object({ ok: z.boolean(), brokenAt: z.number().int().nullable() }),
  paidHoldMs: z.number(),
});
export type IncidentView = z.infer<typeof IncidentViewSchema>;

export const HealthSchema = z.object({ ok: z.boolean(), model: z.boolean(), sandbox: z.boolean(), operator: z.string() });
export type Health = z.infer<typeof HealthSchema>;

/**
 * What the console receives while an agent works. One server-sent event per step, so the page can show the agent's
 * words, each tool it reaches for, and what the code answered, as it happens.
 */
export const AgentStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start"), scope: z.string().nullable(), actor: z.string(), mode: z.enum(["commander", "adversary"]) }),
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("call"), id: z.string(), tool: z.string(), incident: z.string().nullable(), detail: z.string().nullable() }),
  z.object({
    type: z.literal("result"), id: z.string(), tool: z.string(), ok: z.boolean(),
    kind: z.enum(["refused", "invalid", "failed"]).nullable(), summary: z.string(),
  }),
  z.object({
    type: z.literal("done"), steps: z.number().int(), calls: z.number().int(), refused: z.number().int(),
    stoppedBecause: z.enum(["finished", "step_limit", "aborted"]),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type AgentStreamEvent = z.infer<typeof AgentStreamEventSchema>;

/** Error body for every non-2xx answer. `reasons` and `blockers` are sentences a person can act on. */
export const ProblemSchema = z.object({
  error: z.string(),
  message: z.string(),
  reasons: z.array(z.string()).optional(),
  blockers: z.array(z.string()).optional(),
});
export type Problem = z.infer<typeof ProblemSchema>;
