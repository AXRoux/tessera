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

/** A conversion computed by code to fund a replacement (`planFunding`): every number a person or agent is shown. */
export const FundingPlanSchema = z.object({
  currency: z.string(),
  neededMinor: z.number().int(),
  feeMinor: z.number().int(),
  availableMinor: z.number().int(),
  floorMinor: z.number().int(),
  shortfallMinor: z.number().int(),
  buyMinor: z.number().int(),
  minConversionMinor: z.number().int(),
  forAttemptId: z.string(),
  feasible: z.boolean(),
  sellCurrency: z.string().nullable(),
  sellMinor: z.number().int().nullable(),
  rate: z.number().nullable(),
  sources: z.array(
    z.object({
      currency: z.string(), availableMinor: z.number().int(), floorMinor: z.number().int(), rate: z.number().nullable(),
      sellMinor: z.number().int().nullable(), ok: z.boolean(),
    }),
  ),
  limitMinor: z.number().int().nullable(),
  autoApprovable: z.boolean(),
  summary: z.string(),
});
export type FundingPlanWire = z.infer<typeof FundingPlanSchema>;

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
  /** Set when a replacement needs another wallet's money first: the plan, feasible or not. */
  funding: FundingPlanSchema.nullable(),
});

/** A funding conversion as the ledger records it (`conversions` table). */
export const ConversionSchema = z.object({
  id: z.string(),
  obligationId: z.string(),
  forAttemptId: z.string(),
  requestId: z.string(),
  quoteId: z.string(),
  currencyPair: z.string(),
  buyCurrency: z.string(),
  buyMinor: z.number().int(),
  sellCurrency: z.string(),
  sellMinor: z.number().int(),
  rate: z.number(),
  quoteValidTo: z.string(),
  state: z.enum(["INTENT", "BOOKED", "SETTLED", "CANCELLED", "ABANDONED"]),
  conversionId: z.string().nullable(),
  awxStatus: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ConversionWire = z.infer<typeof ConversionSchema>;

/** GET /api/wallets: every wallet's available balance next to the reserve floor the policy keeps in it. */
export const WalletsSchema = z.object({
  /** False when Airwallex could not be read; `wallets` is then empty and every replacement fails closed. */
  readable: z.boolean(),
  wallets: z.array(z.object({ currency: z.string(), availableMinor: z.number().int(), floorMinor: z.number().int(), fundingSource: z.boolean() })),
  /** Wallets the Commander may sell to fund a replacement, most preferred first. */
  fundingSources: z.array(z.string()),
  /** Largest conversion the Commander books on its own, per currency bought. */
  autoConvertLimitMinor: z.record(z.string(), z.number().int()),
});
export type Wallets = z.infer<typeof WalletsSchema>;

/** POST /fund, /fund/approve: the conversion booked (or found) and the wallets read after it settled. */
export const FundingResultSchema = z.object({
  outcome: z.enum(["BOOKED", "ADOPTED_DUPLICATE", "ADOPTED_AFTER_AMBIGUITY", "PENDING_RECOVERY", "REJECTED"]),
  conversion: ConversionSchema,
  walletsAfter: z.record(z.string(), z.number().int()).nullable(),
  /** Why earlier quotes were thrown away (automatic funding only). */
  replans: z.array(z.string()),
});
export type FundingResultWire = z.infer<typeof FundingResultSchema>;

/** POST /fund/quote: step one of a person's approval. The approval must echo `quoteId`, `evidenceHash` and `fingerprint`. */
export const FundingQuoteSchema = z.object({
  obligationId: z.string(),
  forAttemptId: z.string(),
  quoteId: z.string(),
  currencyPair: z.string(),
  buyCurrency: z.string(),
  buyMinor: z.number().int(),
  sellCurrency: z.string(),
  sellMinor: z.number().int(),
  rate: z.number(),
  validFrom: z.string(),
  validTo: z.string(),
  evidenceHash: z.string(),
  fingerprint: z.string(),
  plan: FundingPlanSchema,
});
export type FundingQuote = z.infer<typeof FundingQuoteSchema>;

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
  /**
   * Tessera's latest reaction to a bank-side transfer change on this incident: what made it look (a webhook, named, or
   * the sweep), when, whether the Commander's decision changed, and whether an agent was woken for it.
   */
  lastReaction: z
    .object({
      source: z.enum(["webhook", "sweep", "setup"]),
      eventName: z.string().nullable(),
      eventId: z.string().nullable(),
      at: z.string(),
      to: z.string(),
      before: z.string(),
      after: z.string(),
      decisionChanged: z.boolean(),
      wake: z.enum(["requested", "not_needed", "off", "suppressed"]),
      /** The event-driven run that followed: started, capped or skipped; null if none was asked for or it has not fired yet. */
      woke: z.enum(["started", "capped", "skipped"]).nullable(),
    })
    .nullable(),
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
  /** Every conversion made to fund this invoice's replacements, oldest first. */
  conversions: z.array(ConversionSchema),
  certificate: SignedCertificateSchema.nullable(),
  chain: z.object({ ok: z.boolean(), brokenAt: z.number().int().nullable() }),
  paidHoldMs: z.number(),
});
export type IncidentView = z.infer<typeof IncidentViewSchema>;

export const HealthSchema = z.object({
  ok: z.boolean(),
  /** Who reads supplier messages: the configured model's name ("Claude", "hermes-4-405b", ...), "offline keyword reader", or null for none. */
  reader: z.string().nullable(),
  /** Simulator controls are on: the Airwallex sandbox, or the offline fake. */
  sandbox: z.boolean(),
  /** Simulated Airwallex in-process; no money and no network. */
  offline: z.boolean(),
  /** Signed Airwallex webhooks are accepted (live: on the webhook-only listener; offline: from the simulator). */
  webhooks: z.boolean(),
  /** A verified bank event that changes an incident's decision wakes an agent for that incident (TESSERA_AGENT_ON_EVENT). */
  agentOnEvent: z.boolean(),
  operator: z.string(),
  /** Who drives agent runs: a model (named as the console shows it), the deterministic scripted agent (not a model), or nobody. */
  agent: z.object({ kind: z.enum(["model", "scripted"]), name: z.string() }).nullable(),
  /** The offline demo can be reset to empty (POST /api/demo/reset). Never true against the sandbox. */
  canReset: z.boolean(),
  /** Sandbox or offline: an untouched transfer is sent and paid by Tessera after this many milliseconds (bank-clock.ts). */
  bankClockMs: z.number().int().nullable().optional(),
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

/** Who a new payout from the console pays: the configured Airwallex beneficiary, and the limits it is sent under. */
export const PayeeSchema = z.object({
  beneficiaryId: z.string(),
  nickname: z.string().nullable(),
  currency: z.string(),
  method: z.enum(["LOCAL", "SWIFT"]),
  maxAmount: z.number(),
  operator: z.string(),
});
export type Payee = z.infer<typeof PayeeSchema>;

/**
 * The signed-in person and their workspace, as the host shows it (multi-tenant mode only). Keys never appear: only
 * hints such as "…a3f9", enough to recognise which key is connected.
 */
export const WorkspaceResponseSchema = z.object({
  user: z.object({ name: z.string(), email: z.string() }),
  workspace: z.object({
    mode: z.enum(["offline", "live"]),
    airwallex: z.object({ clientIdHint: z.string(), keyHint: z.string(), beneficiaryId: z.string(), connectedAt: z.string() }).nullable(),
    model: z
      .object({ provider: z.enum(["anthropic", "openai"]), modelId: z.string(), baseUrl: z.string().nullable(), keyHint: z.string(), connectedAt: z.string() })
      .nullable(),
  }),
});
export type WorkspaceResponse = z.infer<typeof WorkspaceResponseSchema>;

/** One charge or decline on a card, as Airwallex reported it. */
export const CardChargeWireSchema = z.object({
  transactionId: z.string(),
  type: z.string(),
  status: z.string(),
  amountMinor: z.number().int(),
  currency: z.string(),
  merchant: z.string().nullable(),
  mcc: z.string().nullable(),
  failureReason: z.string().nullable(),
  at: z.string(),
});

/** An agent's checkout with the card, and what Visa's Trusted Agent Protocol said about it at the merchant. */
export const CardCheckoutWireSchema = z.object({
  at: z.string(),
  actor: z.string(),
  status: z.enum(["APPROVED", "DECLINED", "REJECTED"]),
  orderId: z.string().nullable(),
  reason: z.string().nullable(),
  tapVerified: z.boolean(),
  kid: z.string().nullable(),
});

/** A Visa virtual card and its whole story (src/ledger/cards.ts). */
export const CardViewSchema = z.object({
  id: z.string(),
  purpose: z.string(),
  merchant: z.string(),
  category: z.string(),
  categoryLabel: z.string(),
  mccs: z.array(z.string()),
  amountMinor: z.number().int(),
  currency: z.string(),
  singleUse: z.boolean(),
  activeTo: z.string(),
  state: z.enum(["PENDING", "REFUSED", "DECLINED", "ISSUING", "ACTIVE", "FAILED", "FROZEN", "SPENT", "CLOSED"]),
  requestedBy: z.string(),
  byAgent: z.boolean(),
  reason: z.string(),
  approvedBy: z.string().nullable(),
  last4: z.string().nullable(),
  brand: z.string().nullable(),
  spentMinor: z.number().int(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  charges: z.array(CardChargeWireSchema),
  checkouts: z.array(CardCheckoutWireSchema),
});
export type CardView = z.infer<typeof CardViewSchema>;

export const CardsSchema = z.object({
  items: z.array(CardViewSchema),
  /** Airwallex Issuing is reachable for this workspace (offline: the simulator's). */
  connected: z.boolean(),
  /** Merchant charges can be simulated here (offline or the Airwallex sandbox), and agents can check out. */
  canCharge: z.boolean(),
  categories: z.array(z.object({ id: z.string(), label: z.string(), mccs: z.array(z.string()) })),
  /** Card limits per currency, minor units: what a person and what an agent may ask for on one card. */
  limits: z.array(z.object({ currency: z.string(), personMaxMinor: z.number().int(), agentMaxMinor: z.number().int() })),
  /** The agent's Visa TAP key id, published at /api/tap/keys. */
  agentKeyId: z.string(),
});
export type Cards = z.infer<typeof CardsSchema>;
