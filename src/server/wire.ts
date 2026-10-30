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
  /** What an agent last did on this incident (a verdict, refused or not), read from the ledger's audit events. */
  lastAgentAction: z.object({ actor: z.string(), tool: z.string(), outcome: z.string(), at: z.string() }).nullable(),
  /** Why a person is needed, most urgent reason first; null when nothing is waiting for one. */
  attention: z.object({ kind: z.enum(["ESCALATED", "NEEDS_ACTION", "DRAFT"]), reason: z.string() }).nullable(),
});
export type IncidentSummary = z.infer<typeof IncidentSummarySchema>;

export const IncidentListSchema = z.object({ items: z.array(IncidentSummarySchema) });

export const PendingDraftSchema = DraftRecordedSchema.extend({ seq: z.number().int(), at: z.string() });

/** A supplier message waiting in the incident's inbox. `read` means an EVIDENCE_RECORDED event references it. */
export const InboxItemSchema = z.object({ id: z.string(), from: z.string(), receivedAt: z.string(), read: z.boolean() });
export type InboxItem = z.infer<typeof InboxItemSchema>;

export const IncidentViewSchema = z.object({
  obligation: ObligationSchema,
  attempts: z.array(AttemptSchema),
  events: z.array(LedgerEventSchema),
  evidence: RecordedEvidenceSchema.nullable(),
  /** A supplier reply an agent drafted that no person has dealt with yet. */
  draft: PendingDraftSchema.nullable(),
  assessment: z.object({ decision: DecisionSchema, evidenceHash: z.string() }).nullable(),
  /**
   * The hash of the assessment the decision on this page came from; send it back with an approval. Null only when the
   * assessment itself failed (then `assessmentError` says why and nothing can be approved).
   */
  evidenceHash: z.string().nullable(),
  assessmentError: z.string().nullable(),
  inbox: z.array(InboxItemSchema),
  certificate: SignedCertificateSchema.nullable(),
  chain: z.object({ ok: z.boolean(), brokenAt: z.number().int().nullable() }),
  paidHoldMs: z.number(),
});
export type IncidentView = z.infer<typeof IncidentViewSchema>;

export const HealthSchema = z.object({
  ok: z.boolean(),
  /** A reader for supplier messages is available (Claude, or the offline keyword reader). */
  model: z.boolean(),
  /** Simulator controls are on: the Airwallex sandbox, or the offline fake. */
  sandbox: z.boolean(),
  /** Simulated Airwallex in-process; no money and no network. */
  offline: z.boolean(),
  /** POST /api/webhooks/airwallex is accepting signed events. */
  webhooks: z.boolean(),
  operator: z.string(),
  /** Who drives agent runs: Claude, the deterministic scripted agent (not Claude), or nobody. */
  agent: z.enum(["claude", "scripted"]).nullable(),
  /** The offline demo can be reset to empty (POST /api/demo/reset). Never true against the sandbox. */
  canReset: z.boolean(),
});
export type Health = z.infer<typeof HealthSchema>;

/** Board numbers, derived from ledger events only. */
export const MetricsSchema = z.object({
  incidents: z.number().int(),
  open: z.number().int(),
  escalated: z.number().int(),
  certified: z.number().int(),
  autoReplaced: z.number().int(),
  /** Money-moving requests refused by code: agent replace refusals, human approve/replace refusals, duplicate locks. */
  paymentsRefused: z.number().int(),
  /** Minor units of the refused requests, per currency. */
  refusedAmountMinor: z.record(z.string(), z.number().int()),
  /** Every agent tool call that code refused, money-moving or not. */
  agentRefusals: z.number().int(),
  /** Median of certificate time minus obligation creation over certified incidents. */
  medianResolutionMs: z.number().nullable(),
});
export type Metrics = z.infer<typeof MetricsSchema>;

export const SeedResultSchema = z.object({
  seeded: z.array(z.object({ id: z.string(), reference: z.string(), expected: z.string() })),
});
export type SeedResult = z.infer<typeof SeedResultSchema>;

export const InboxCreatedSchema = z.object({ id: z.string() });
export const EscalationResolvedSchema = z.object({ status: ObligationSchema.shape.status });
export const AttemptResolvedSchema = z.object({ attemptId: z.string(), state: AttemptStateSchema });

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
    stoppedBecause: z.enum(["finished", "step_limit", "call_limit", "aborted"]),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type AgentStreamEvent = z.infer<typeof AgentStreamEventSchema>;

/** Error body for every non-2xx answer. `reasons` and `blockers` are sentences a person can act on. */
export const ProblemSchema = z.object({
  error: z.string(),
  message: z.string(),
  /** Machine-readable refusal reason when there is one, e.g. "stale_evidence" on an approval of facts that moved. */
  code: z.string().optional(),
  reasons: z.array(z.string()).optional(),
  blockers: z.array(z.string()).optional(),
});
export type Problem = z.infer<typeof ProblemSchema>;
