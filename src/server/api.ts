import { ModelError } from "../commander/model";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { WRITTEN_NOTE_MIN_CHARS } from "../approval/approval";
import { AwxHttpError } from "../airwallex/types";
import { sha256Hex } from "../canonical";
import { createToolbox } from "../agent/toolbox";
import { ADVERSARY_SYSTEM, adversaryTask, COMMANDER_SYSTEM, runAgent, type AgentModel } from "../agent/loop";
import { summarize } from "../agent/summary";
import { SignedCertificateSchema } from "../closer/certificate";
import type { Closer } from "../closer/closer";
import type { Commander } from "../commander/commander";
import { pendingDraft } from "../commander/drafts";
import {
  ExtractedEvidenceSchema,
  effectiveEvidence,
  readSupplierMessage,
  type StructuredModel,
  type SupplierEvidence,
} from "../commander/evidence";
import {
  ApprovalRejected,
  AutoReplacementRefused,
  DuplicateConversionError,
  DuplicateLockError,
  FundingRefused,
  LedgerMismatchError,
  NotClosable,
  ObligationNotPayable,
  ReplacementDenied,
  StateConflict,
} from "../errors";
import { seedAcme } from "../demo/scenario";
import type { PayoutGateway } from "../gateway/gateway";
import type { Attempt, Ledger, LedgerEvent, Obligation } from "../ledger/ledger";
import { toMinor } from "../money";
import { EmlNotPlainText, parseEml } from "./eml";
import { computeMetrics } from "./metrics";
import { attentionOf, lastAgentAction, lastReaction } from "./attention";
import { AgentGate, runLimits, scopedTask, scopedTasks } from "./agent-runs";
import type { Reactor } from "./reactions";
import type { AgentStreamEvent, CardView, Cards, FundingQuote, FundingResultWire, Health, IncidentSummary, IncidentView, Payee, SeedResult, Wallets } from "./wire";
import type { CardDesk } from "../cards/desk";
import { CARD_CATEGORIES } from "../cards/policy";
import { heldFrom, type CardRow } from "../ledger/cards";

/** Sandbox or offline only: moves a transfer through Airwallex's simulator (or the fake's). Kept behind one interface so it can be removed. */
export interface Simulator {
  advance(transferId: string, status: string, failureType?: string): Promise<void>;
  /** Offline only: runs `fn` without the simulated webhook deliveries (seeding the demo writes history, not news). */
  withoutEvents?<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Sets a wallet's available balance (major units) before demo incidents are seeded: the fake's balance offline, spot
   * conversions against USD on the sandbox (`src/demo/stage-wallet.ts`). Absent: the funding incident cannot be staged.
   */
  stageWallet?(currency: string, availableMajor: number): Promise<void>;
}

/** The model that drives the console's agent runs. Null or absent means the run endpoint answers 503. */
export interface AgentDeps {
  model: AgentModel;
  /** Names the agent in the ledger and the console, e.g. "agent:claude", "agent:hermes-4-405b". */
  actor: string;
  /** A model (Claude or any OpenAI-compatible one), or the deterministic scripted agent (src/demo/scripted-agent.ts). Shown to the operator as such. */
  kind: "model" | "scripted";
  /** How the console names it: the model's label, or "scripted agent". */
  name: string;
  /** Fixed model-turn ceiling; absent means it scales with the open incidents in scope. */
  maxSteps?: number;
}

export interface ApiDeps {
  ledger: Ledger;
  gateway: PayoutGateway;
  commander: Commander;
  closer: Closer;
  /** Visa virtual cards issued by Airwallex (src/cards/desk.ts). Absent: the card routes answer 404. */
  cards?: CardDesk;
  /** Null when no model is configured; the reader endpoint then answers 503. */
  model: StructuredModel | null;
  /** How the console names the reader (the model's label, or "offline keyword reader"); defaults to "model". */
  readerName?: string | null;
  simulator: Simulator | null;
  /** Shared secret for the single operator session; the Next.js server holds it, browsers never do. */
  token: string;
  /** Identity stamped on every human approval. Authentication of a person happens upstream of this API. */
  operator: string;
  beneficiaryId: string;
  /** The EUR (SWIFT) supplier the funding demo incident pays. Absent or null: seeding answers 409 until `bun run setup` creates it. */
  eurBeneficiaryId?: string | null;
  paidHoldMs: number;
  /** Largest obligation this sandbox API will create, in major units. */
  maxAmount?: number;
  /** The Airwallex beneficiaries on the account, for naming the payee a new payout goes to. Absent: the payee is shown by id. */
  payees?: () => Promise<{ id: string; nickname?: string }[]>;
  agent?: AgentDeps | null;
  /** Airwallex is the in-process simulator: no money, no network. */
  offline?: boolean;
  /** Sandbox or offline: milliseconds before Tessera answers for the bank on an untouched transfer; null when it does not. */
  bankClockMs?: number | null;
  /** Whether the webhook listener is on (AWX_WEBHOOK_SECRET set), and whether a verified bank event may wake an agent. */
  webhooks?: { listening: boolean; agentOnEvent: boolean };
  /** Shared with the event-driven wakes (src/server/wake.ts), so a console run and a woken one never overlap. */
  agentGate?: AgentGate;
  /** Reassesses incidents after bank-side changes (src/server/reactions.ts); used here to mark demo seeding as history. */
  reactor?: Pick<Reactor, "react">;
  /** Offline demo only: throw the in-memory state away and start empty. Absent means the route answers 403. */
  reset?: () => Promise<void>;
}

/** What any one route accepts after reading the body (checked on the text, so it counts characters). */
const MAX_BODY_BYTES = 64 * 1024;
/**
 * What the HTTP server accepts at all (`Bun.serve` `maxRequestBodySize`): above the largest legitimate request, so the
 * route's own 413 answers anything near it, and far below Bun's 128 MB default. The largest route is a supplier message
 * (up to 20 000 characters of email and 20 000 of statement, which JSON-encodes to well under this).
 */
export const MAX_REQUEST_BODY_BYTES = 256 * 1024;
const EVENT_WINDOW = 80;

const WrittenNote = z
  .string()
  .trim()
  .min(WRITTEN_NOTE_MIN_CHARS, `write a note of at least ${WRITTEN_NOTE_MIN_CHARS} characters explaining the action`)
  .max(500);
const CreateBody = z.object({
  amount: z.number().positive().default(25),
  reference: z.string().min(1).max(40).optional(),
  /** The person's own reason for paying, signed onto the first approval. Absent: the scheduled-run note. */
  note: WrittenNote.optional(),
});
const NoteBody = z.object({ note: WrittenNote });
const ApproveBody = z.object({
  note: z.string().trim().min(WRITTEN_NOTE_MIN_CHARS, `write a note of at least ${WRITTEN_NOTE_MIN_CHARS} characters explaining the approval`).max(500),
  evidenceHash: z.string().regex(/^[0-9a-f]{64}$/),
  beneficiaryId: z.string().min(1).optional(),
  method: z.enum(["LOCAL", "SWIFT"]).optional(),
  reason: z.string().min(1).optional(),
});
const ManualEvidenceBody = z.object({
  claimsNonReceipt: z.boolean(),
  requestsDetailChange: z.boolean(),
  referencesObligation: z.boolean(),
  containsEmbeddedInstructions: z.boolean(),
  statementCreditMinor: z.number().int().positive().nullable(),
  summary: z.string().max(400),
});
const ResolveDraftBody = z.object({ draftSeq: z.number().int().positive(), resolution: z.enum(["SENT", "DISCARDED"]) });
const CardRequestBody = z.object({
  purpose: z.string().trim().min(3).max(120),
  merchant: z.string().trim().min(2).max(60),
  category: z.string().min(1).max(40),
  amount: z.number().positive().max(1_000_000),
  currency: z.string().length(3).default("USD"),
  singleUse: z.boolean().default(true),
  reason: z.string().trim().min(1).max(500),
});
const CardNoteBody = z.object({ note: z.string().max(500) });
/** Sandbox only: open other currency wallets on an account that holds one, by buying them from USD. */
const StageWalletsBody = z.object({
  currencies: z.array(z.enum(["EUR", "GBP"])).min(1).default(["EUR", "GBP"]),
  amount: z.number().positive().max(50_000).default(5_000),
});
const CardStatusBody = z.object({ why: z.string().max(300).default("") });
const CardChargeBody = z.object({ amount: z.number().positive().max(1_000_000), merchantCategoryCode: z.string().regex(/^\d{4}$/), merchant: z.string().trim().max(60).optional() });
const CardCheckoutBody = z.object({ amount: z.number().positive().max(1_000_000) });
const CardCheckoutEventSchema = z.looseObject({
  cardId: z.string(),
  actor: z.string(),
  status: z.enum(["APPROVED", "DECLINED", "REJECTED"]),
  orderId: z.string().nullable(),
  reason: z.string().nullable(),
  tap: z.looseObject({ verified: z.boolean(), kid: z.string().optional() }),
});
const AgentRunBody = z.object({
  incidentId: z.string().min(1).max(64).optional(),
  /** A run over exactly these invoices (the board's "work these"), and nothing else. */
  incidentIds: z.array(z.string().min(1).max(64)).min(1).max(50).optional(),
  mode: z.enum(["commander", "adversary"]).default("commander"),
});
const ReadBody = z
  .object({
    messageId: z.string().min(1).max(64).optional(),
    email: z.string().min(1).max(20_000).optional(),
    statementText: z.string().max(20_000).optional(),
  })
  .refine((v) => (v.messageId === undefined) !== (v.email === undefined), "give exactly one of messageId or email");
const InboxBody = z.object({
  from: z.string().trim().min(3).max(320).optional(),
  email: z.string().min(1).max(60_000),
  statementText: z.string().max(20_000).optional(),
});
const SimulateBody = z.object({ status: z.enum(["SENT", "PAID", "FAILED"]), failureType: z.string().regex(/^[A-Z0-9_]+$/).optional() });
/** Step two of a person's funding approval: the quote they reviewed, echoed back with its fingerprint. No amount, no rate. */
const FundApproveBody = z.object({
  note: WrittenNote,
  evidenceHash: z.string().regex(/^[0-9a-f]{64}$/),
  quoteId: z.string().min(1).max(64),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});

const json = (body: unknown, status = 200): Response => Response.json(body, { status, headers: { "cache-control": "no-store" } });

const KNOWN: Array<[new (...args: never[]) => Error, number]> = [
  [DuplicateLockError, 409],
  [DuplicateConversionError, 409],
  [ReplacementDenied, 409],
  [AutoReplacementRefused, 409],
  [ApprovalRejected, 409],
  [ObligationNotPayable, 409],
  [LedgerMismatchError, 409],
  [StateConflict, 409],
];

/**
 * Refusals of a money-moving request. Raised on /replace, /approve, /fund or /fund/approve, each is written to the
 * ledger as PAYMENT_REFUSED.
 */
const PAYMENT_REFUSALS: Array<new (...args: never[]) => Error> = [
  AutoReplacementRefused, ReplacementDenied, DuplicateLockError, ApprovalRejected, ObligationNotPayable, FundingRefused, DuplicateConversionError,
];

function problem(error: unknown): Response {
  if (error instanceof NotClosable) return json({ error: error.name, message: error.message, blockers: error.blockers }, 409);
  if (error instanceof AutoReplacementRefused) {
    return json({ error: error.name, message: error.message, reasons: error.decision.reasons }, 409);
  }
  if (error instanceof FundingRefused) return json({ error: error.name, message: error.message, reasons: error.reasons }, 409);
  if (error instanceof ApprovalRejected) return json({ error: error.name, message: error.message, code: error.reason }, 409);
  if (error instanceof z.ZodError) return json({ error: "BadRequest", message: z.prettifyError(error) }, 400);
  if (error instanceof EmlNotPlainText) return json({ error: "BadRequest", message: error.message }, 400);
  // The model's provider refused or failed (no credit, a bad key, an outage): say so in its words, not as a crash.
  if (error instanceof ModelError) {
    return json({ error: "ModelUnavailable", message: `The model could not answer: ${error.message.replace(/^model API \d+:\s*/, "")}` }, 502);
  }
  for (const [type, status] of KNOWN) {
    if (error instanceof type) return json({ error: error.name, message: error.message }, status);
  }
  console.error("unhandled", error);
  return json({ error: "InternalError", message: error instanceof Error ? error.message : "unexpected failure" }, 500);
}

async function body<S extends z.ZodType>(request: Request, schema: S): Promise<z.infer<S>> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new PayloadTooLarge();
  return schema.parse(text.length > 0 ? JSON.parse(text) : {});
}

class PayloadTooLarge extends Error {}

const MessageRefSchema = z.object({ messageId: z.string() });

export function createApi(deps: ApiDeps): (request: Request) => Promise<Response> {
  const { ledger, gateway, commander, closer } = deps;

  const authorized = (request: Request): boolean => {
    const given = Buffer.from(request.headers.get("x-tessera-token") ?? "");
    const wanted = Buffer.from(deps.token);
    return given.length === wanted.length && timingSafeEqual(given, wanted);
  };

  // The board asks every few seconds; one balance read serves every invoice on it, and is reused for a few seconds.
  let walletsRead: { at: number; value: Promise<Record<string, number> | null> } | null = null;
  const boardWallets = (): Promise<Record<string, number> | null> => {
    if (!walletsRead || Date.now() - walletsRead.at > 5_000) walletsRead = { at: Date.now(), value: commander.readWallets() };
    return walletsRead.value;
  };

  // A replacement that needs funding is only decided right with its rates; they are read for those few, and reused a while.
  const ratesRead = new Map<string, { at: number; value: Promise<Record<string, number | null>> }>();
  const boardRates = (currency: string, buyMinor: number): Promise<Record<string, number | null>> => {
    const key = `${currency}:${buyMinor}`;
    const hit = ratesRead.get(key);
    if (hit && Date.now() - hit.at < 30_000) return hit.value;
    const value = commander.ratesFor(currency, buyMinor).catch(() => ({}));
    ratesRead.set(key, { at: Date.now(), value });
    return value;
  };

  /** The next move on an invoice, decided on the ledger as it stands: the same decision the incident page shows, without a sync. */
  const nextFor = async (o: Obligation, attempts: Attempt[], events: LedgerEvent[], wallets: Record<string, number> | null): Promise<IncidentSummary["next"]> => {
    try {
      const evidence = effectiveEvidence(events, o.amountMinor)?.evidence ?? null;
      const snapshot = { obligation: o, attempts, events };
      let d = commander.decideOn(snapshot, evidence, wallets);
      if (d.funding) d = commander.decideOn(snapshot, evidence, wallets, await boardRates(d.funding.currency, d.funding.buyMinor));
      return { action: d.recommended, allowed: d.allowed, recheckAt: d.recheckAt, autoReplace: d.replacement?.autoApprovable ?? false };
    } catch {
      return null;
    }
  };

  const summary = async (o: Obligation, wallets: Record<string, number> | null = null): Promise<IncidentSummary> => {
    const attempts = ledger.attemptsFor(o.id);
    const latest = attempts.at(-1);
    const events = ledger.events(o.id);
    const read = new Set(events.flatMap((e) => (e.type === "EVIDENCE_RECORDED" ? [MessageRefSchema.safeParse(e.payload).data?.messageId] : [])));
    return {
      id: o.id, reference: o.reference, amountMinor: o.amountMinor, currency: o.currency, method: o.method,
      status: o.status, attemptCount: attempts.length, updatedAt: o.updatedAt,
      latest: latest ? { seq: latest.seq, state: latest.state, awxStatus: latest.awxStatus, failureCode: latest.failureCode } : null,
      lastAgentAction: lastAgentAction(events),
      attention: attentionOf(o, latest, events),
      lastReaction: lastReaction(events),
      next: await nextFor(o, attempts, events, wallets),
      unread: ledger.inboxMessages(o.id).filter((m) => !read.has(m.id)).length,
    };
  };

  const view = async (id: string): Promise<IncidentView> => {
    const events = ledger.events(id);
    const recorded = effectiveEvidence(events, ledger.requireObligation(id).amountMinor);
    let assessment: IncidentView["assessment"] = null;
    let assessmentError: string | null = null;
    try {
      const a = await commander.assess(id, recorded?.evidence ?? null);
      assessment = { decision: a.decision, evidenceHash: a.evidenceHash };
    } catch (error) {
      assessmentError = error instanceof Error ? error.message : "assessment failed";
    }
    const chain = ledger.verifyChain();
    const stored = ledger.getCertificateJson(id);
    const read = new Set(events.flatMap((e) => (e.type === "EVIDENCE_RECORDED" ? [MessageRefSchema.safeParse(e.payload).data?.messageId] : [])));
    return {
      obligation: ledger.requireObligation(id),
      attempts: ledger.attemptsFor(id),
      events: ledger.events(id).slice(-EVENT_WINDOW),
      evidence: recorded,
      draft: pendingDraft(events),
      assessment,
      evidenceHash: assessment?.evidenceHash ?? null,
      assessmentError,
      inbox: ledger.inboxMessages(id).map((m) => ({ id: m.id, from: m.from, receivedAt: m.receivedAt, read: read.has(m.id) })),
      conversions: ledger.conversionsFor(id),
      certificate: stored ? SignedCertificateSchema.parse(JSON.parse(stored)) : null,
      chain: { ok: chain.ok, brokenAt: chain.ok ? null : chain.brokenAt },
      paidHoldMs: deps.paidHoldMs,
    };
  };

  const record = (
    obligationId: string,
    evidence: SupplierEvidence,
    source: "manual" | "model",
    message: { email: string; statementText?: string } | null,
    messageId: string | null = null,
  ) => ledger.tx(() => ledger.append(obligationId, "EVIDENCE_RECORDED", { evidence, source, enteredBy: deps.operator, message, messageId }));

  /** A typed refusal of a money-moving request goes on the record before the operator sees it, then propagates. */
  const onRefusal = (obligationId: string, route: "replace" | "approve" | "fund" | "fund/quote" | "fund/approve") => (error: unknown): never => {
    if (error instanceof Error && PAYMENT_REFUSALS.some((type) => error instanceof type)) {
      ledger.append(obligationId, "PAYMENT_REFUSED", { by: deps.operator, route, error: error.name, message: error.message.slice(0, 300) });
    }
    throw error;
  };

  const gate = deps.agentGate ?? new AgentGate();

  /** Streams an agent run as server-sent events. One run at a time: two agents on one ledger help nobody. */
  async function startAgentRun(request: Request): Promise<Response> {
    const agent = deps.agent;
    if (!agent) return json({ error: "ModelUnavailable", message: "no model is configured on this server" }, 503);
    // Claimed before the first await: two requests arriving together must not both pass. Shared with event-driven wakes.
    if (!gate.tryAcquire()) return json({ error: "Conflict", message: "an agent run is already in progress" }, 409);
    let streaming = false;
    try {
      const response = await openAgentStream(request, agent);
      // Only a started stream owns the flag (its own finally releases it); every other answer releases it here.
      streaming = response.headers.get("content-type") === "text/event-stream";
      return response;
    } finally {
      if (!streaming) gate.release();
    }
  }

  async function openAgentStream(request: Request, agent: AgentDeps): Promise<Response> {
    const input = await body(request, AgentRunBody);
    // Red-teaming the system with a hostile prompt is a demonstration, so it exists only where no real money can move.
    if (input.mode === "adversary" && !deps.simulator) {
      return json({ error: "Forbidden", message: "adversary mode is available only against the Airwallex sandbox or the offline demo" }, 403);
    }
    const adversary = input.mode === "adversary";
    const actor = adversary ? "agent:adversary" : agent.actor;
    let scope: Set<string> | null = null;
    let scopeLabel: string | null = null;
    let scoped: Obligation | null = null;
    let chosen: Obligation[] = [];
    if (input.incidentId) {
      scoped = ledger.getObligation(input.incidentId);
      if (!scoped) return json({ error: "NotFound", message: "no such obligation" }, 404);
      scope = new Set([scoped.id]);
      scopeLabel = scoped.reference;
    } else if (input.incidentIds) {
      // The board names the invoices it wants worked; the run is held to exactly those, and the tools refuse the rest.
      chosen = [...new Set(input.incidentIds)].map((id) => ledger.getObligation(id)).filter((o): o is Obligation => o !== null);
      if (chosen.length === 0) return json({ error: "NotFound", message: "none of those invoices exist" }, 404);
      if (chosen.length === 1) scoped = chosen[0]!;
      scope = new Set(chosen.map((o) => o.id));
      scopeLabel = chosen.map((o) => o.reference).join(", ");
    }
    const { maxSteps, maxCalls } = runLimits(ledger, scope, { adversary, ...(agent.maxSteps !== undefined ? { fixedSteps: agent.maxSteps } : {}) });

    const abort = new AbortController();
    const encoder = new TextEncoder();
    const referenceOf = (id: unknown): string | null => (typeof id === "string" ? ledger.getObligation(id)?.reference ?? null : null);

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: AgentStreamEvent): void => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch {
            /* the reader left; the abort signal will stop the run at the next step */
          }
        };
        // A comment line every few seconds keeps proxies and the server's idle timer from closing a quiet stream.
        const keepalive = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            /* closed */
          }
        }, 8_000);
        try {
          send({ type: "start", scope: scopeLabel, actor, mode: input.mode });
          const toolbox = createToolbox({
            ledger, gateway, commander, closer, model: deps.model, actor,
            // The console agent may only read messages already in the ledger inbox, never text of its own.
            acceptClientText: false, ...(scope ? { scope } : {}), ...(deps.cards ? { cards: deps.cards } : {}),
          });
          const task = adversary
            ? adversaryTask(scopeLabel)
            : scoped
              ? scopedTask(scoped)
              : chosen.length > 0
                ? scopedTasks(chosen)
                : "Work every open incident and report.";
          const run = await runAgent({
            model: agent.model, toolbox, system: adversary ? ADVERSARY_SYSTEM : COMMANDER_SYSTEM, task,
            maxSteps, maxCalls, signal: abort.signal,
            onEvent(event) {
              if (event.type === "text") return send({ type: "text", text: event.text });
              const input = event.type === "call" ? (event.input as Record<string, unknown> | null) : null;
              if (event.type === "call") {
                const raw = input?.reason ?? input?.note ?? null;
                return send({
                  type: "call", id: event.id, tool: event.tool, incident: referenceOf(input?.incidentId),
                  detail: typeof raw === "string" ? (raw.length > 170 ? `${raw.slice(0, 167).replace(/\s+\S*$/, "")}…` : raw) : null,
                });
              }
              send({
                type: "result", id: event.id, tool: event.tool, ok: event.outcome.ok,
                kind: event.outcome.ok ? null : event.outcome.kind, summary: summarize(event.tool, event.outcome),
              });
            },
          });
          send({
            type: "done", steps: run.steps, calls: run.calls.length, stoppedBecause: run.stoppedBecause,
            refused: run.calls.filter((c) => !c.outcome.ok && c.outcome.kind === "refused").length,
          });
        } catch (error) {
          console.error("agent run failed", error);
          send({ type: "error", message: error instanceof Error ? error.message.slice(0, 200) : "the agent run failed" });
        } finally {
          clearInterval(keepalive);
          gate.release();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      },
      cancel() {
        abort.abort();
      },
    });

    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-store, no-transform", "x-accel-buffering": "no" },
    });
  }

  /** Every card with its charges and its agent checkouts, newest first. */
  const cardViews = (desk: CardDesk): CardView[] => {
    const checkouts = new Map<string, CardView["checkouts"]>();
    for (const event of ledger.events()) {
      if (event.type !== "CARD_CHECKOUT") continue;
      const p = CardCheckoutEventSchema.safeParse(event.payload);
      if (!p.success) continue;
      const list = checkouts.get(p.data.cardId) ?? [];
      list.push({ at: event.ts, actor: p.data.actor, status: p.data.status, orderId: p.data.orderId, reason: p.data.reason, tapVerified: p.data.tap.verified, kid: p.data.tap.kid ?? null });
      checkouts.set(p.data.cardId, list);
    }
    const view = (card: CardRow): CardView => ({
      id: card.id, purpose: card.purpose, merchant: card.merchant, category: card.category, categoryLabel: CARD_CATEGORIES[card.category]?.label ?? card.category,
      mccs: card.mccs, amountMinor: card.amountMinor, currency: card.currency, singleUse: card.singleUse, activeTo: card.activeTo, state: card.state,
      requestedBy: card.requestedBy, byAgent: card.requestedBy.startsWith("agent:"), reason: card.reason, approvedBy: card.approvedBy, last4: card.last4,
      brand: card.brand, spentMinor: card.spentMinor, heldMinor: heldFrom(desk.charges(card.id)),
      lastError: card.lastError, createdAt: card.createdAt,
      charges: desk.charges(card.id).map(({ cardId: _cardId, ...charge }) => charge), checkouts: checkouts.get(card.id) ?? [],
      settlements: desk.settlements(card.id).map(({ cardId: _cardId, ...settlement }) => settlement),
    });
    return desk.list().map(view);
  };

  async function cardRoutes(request: Request, path: string, desk: CardDesk): Promise<Response> {
    if (path === "/api/cards") {
      if (request.method === "GET") {
        const cards: Cards = {
          items: cardViews(desk),
          connected: desk.issuingConnected,
          canCharge: desk.canCharge,
          categories: Object.entries(CARD_CATEGORIES).map(([id, c]) => ({ id, label: c.label, mccs: [...c.mccs] })),
          limits: Object.entries(desk.policy.maxPerCardMinor).map(([currency, personMaxMinor]) => ({ currency, personMaxMinor, agentMaxMinor: desk.policy.agentMaxMinor[currency] ?? 0 })),
          agentKeyId: desk.agentJwk.kid,
        };
        return json(cards);
      }
      if (request.method === "POST") {
        const input = await body(request, CardRequestBody);
        const card = await desk.request({ ...input, requestedBy: deps.operator });
        return json({ id: card.id, state: card.state, reasons: card.state === "REFUSED" ? card.lastError : null }, 201);
      }
      return json({ error: "MethodNotAllowed", message: "unsupported method" }, 405);
    }
    const match = path.match(/^\/api\/cards\/([\w-]+)\/(approve|decline|retry|freeze|unfreeze|close|charge|checkout)$/);
    if (!match || request.method !== "POST") return json({ error: "NotFound", message: "no such route" }, 404);
    const [, id, action] = match as unknown as [string, string, string];
    switch (action) {
      case "approve":
        return json({ id, state: (await desk.approve(id, deps.operator, (await body(request, CardNoteBody)).note)).state });
      case "decline":
        return json({ id, state: desk.decline(id, deps.operator, (await body(request, CardNoteBody)).note).state });
      case "retry":
        return json({ id, state: (await desk.retry(id, deps.operator)).state });
      case "freeze":
      case "unfreeze":
      case "close": {
        const { why } = await body(request, CardStatusBody);
        const to = action === "freeze" ? "FROZEN" : action === "unfreeze" ? "ACTIVE" : "CLOSED";
        return json({ id, state: (await desk.setStatus(id, to, deps.operator, why)).state });
      }
      case "charge": {
        const input = await body(request, CardChargeBody);
        return json({ id, state: (await desk.simulateCharge(id, input)).state });
      }
      case "checkout": {
        // The agent pays with the card the person signed, through Visa TAP. Pressed by a person, signed by the agent's key.
        const { amount } = await body(request, CardCheckoutBody);
        const card = ledger.requireCard(id);
        const { result } = await desk.agentCheckout(id, { amount, merchant: card.merchant }, deps.agent?.actor ?? "agent:tessera");
        return json({ id, ...result });
      }
    }
    return json({ error: "NotFound", message: "no such route" }, 404);
  }

  return async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      // Airwallex's webhooks are not served here: they reach the webhook-only listener (src/server/webhook-listener.ts),
      // so a tunnel never needs to expose this port.
      if (!authorized(request)) return json({ error: "Unauthorized", message: "missing or invalid token" }, 401);

      if (request.method === "GET" && path === "/api/health") {
        const health: Health = {
          ok: true, reader: deps.model ? (deps.readerName ?? "model") : null, sandbox: deps.simulator !== null, offline: deps.offline ?? false,
          webhooks: deps.webhooks?.listening ?? false, agentOnEvent: deps.webhooks?.agentOnEvent ?? false,
          operator: deps.operator, agent: deps.agent ? { kind: deps.agent.kind, name: deps.agent.name } : null, canReset: deps.reset !== undefined,
          bankClockMs: deps.bankClockMs ?? null,
        };
        return json(health);
      }
      if (request.method === "GET" && path === "/api/metrics") return json(computeMetrics(ledger));
      if (request.method === "POST" && path === "/api/demo/seed") {
        // Demo incidents move simulated or sandbox money only; against production there is no simulator and no seeding.
        if (!deps.simulator) return json({ error: "Forbidden", message: "demo incidents can be seeded only offline or against the Airwallex sandbox" }, 403);
        const simulator = deps.simulator;
        const eur = deps.eurBeneficiaryId;
        if (!eur) return json({ error: "Conflict", message: "no EUR beneficiary for the funding incident: run `bun run setup` to create spike-eu-supplier" }, 409);
        const seed = () => seedAcme({ ledger, gateway, commander, simulator, approver: deps.operator }, { USD: deps.beneficiaryId, EUR: eur });
        // Offline, seeding writes seven incidents' history at once; it is not news for the event-driven agent. (Against the
        // sandbox Airwallex sends its real webhooks regardless, and they are handled like any other.)
        const seeded = await (simulator.withoutEvents ? simulator.withoutEvents(seed) : seed());
        // Their transfer changes are recorded as reacted to, so the sweep does not later mistake them for news.
        await deps.reactor?.react({ source: "setup" });
        const result: SeedResult = { seeded: seeded.map(({ id, reference, expected }) => ({ id, reference, expected })) };
        return json(result, 201);
      }
      if (request.method === "POST" && path === "/api/demo/reset") {
        // Only the offline demo can be reset: a live ledger is the record of real sandbox transfers.
        if (!deps.reset) return json({ error: "Forbidden", message: "reset exists only in the offline demo" }, 403);
        await deps.reset();
        return json({ ok: true });
      }
      if (request.method === "POST" && path === "/api/agent/run") return await startAgentRun(request);
      if (path === "/api/tap/keys" && request.method === "GET") {
        // Visa TAP "Public Keys Retrieval": the keys a merchant needs to verify this workspace's agent.
        return json({ keys: deps.cards ? [deps.cards.agentJwk] : [] });
      }
      if (path === "/api/cards" || path.startsWith("/api/cards/")) {
        if (!deps.cards) return json({ error: "NotFound", message: "cards are not available here" }, 404);
        return await cardRoutes(request, path, deps.cards);
      }
      if (request.method === "GET" && path === "/api/wallets") {
        const read = await commander.readWallets();
        const { reserveFloorMinor, fundingSources, autoConvertLimitMinor } = commander.policy;
        const wallets: Wallets = {
          readable: read !== null,
          wallets: Object.entries(read ?? {})
            .filter(([currency, availableMinor]) => availableMinor !== 0 || currency in reserveFloorMinor)
            .map(([currency, availableMinor]) => ({ currency, availableMinor, floorMinor: reserveFloorMinor[currency] ?? 0, fundingSource: fundingSources.includes(currency) }))
            .sort((a, b) => a.currency.localeCompare(b.currency)),
          fundingSources: [...fundingSources],
          autoConvertLimitMinor,
        };
        return json(wallets);
      }
      if (request.method === "POST" && path === "/api/wallets/stage") {
        // A new sandbox business holds USD only; buying a little EUR and GBP gives the treasury (and funding) something to show.
        const stage = deps.simulator?.stageWallet;
        if (!stage) return json({ error: "Forbidden", message: "other wallets can be opened only offline or on the Airwallex sandbox" }, 403);
        const { currencies, amount } = await body(request, StageWalletsBody);
        const read = (await commander.readWallets()) ?? {};
        for (const currency of currencies) {
          if ((read[currency] ?? 0) < toMinor(amount, currency)) await stage.call(deps.simulator, currency, amount);
        }
        return json({ ok: true, staged: currencies });
      }
      if (request.method === "GET" && path === "/api/payee") {
        // Who a new payout pays, named as Airwallex has it. A failed lookup still answers with the id: the payout works without a name.
        const listed = await (deps.payees?.() ?? Promise.resolve([])).catch(() => []);
        const nickname = listed.find((b) => b.id === deps.beneficiaryId)?.nickname ?? null;
        const payee: Payee = { beneficiaryId: deps.beneficiaryId, nickname, currency: "USD", method: "LOCAL", maxAmount: deps.maxAmount ?? 1_000, operator: deps.operator };
        return json(payee);
      }
      if (request.method === "GET" && path === "/api/obligations") {
        const wallets = await boardWallets();
        return json({ items: (await Promise.all(ledger.listObligations().map((o) => summary(o, wallets)))).toReversed() });
      }
      if (request.method === "POST" && path === "/api/obligations") {
        const input = await body(request, CreateBody);
        if (input.amount > (deps.maxAmount ?? 1_000)) return json({ error: "BadRequest", message: `amount above the sandbox limit of ${deps.maxAmount ?? 1_000}` }, 400);
        const reference = input.reference ?? `INV-${Date.now().toString(36).toUpperCase()}${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
        // The Closer finds stray payments by reference, so two incidents sharing one would block each other's certificate.
        if (ledger.listObligations().some((o) => o.reference === reference)) {
          return json({ error: "Conflict", message: `reference ${reference} is already used by another invoice` }, 409);
        }
        const obligation = ledger.createObligation({
          reference,
          beneficiaryId: deps.beneficiaryId,
          amountMinor: toMinor(input.amount, "USD"),
          currency: "USD",
          method: "LOCAL",
          reason: "professional_business_services",
        });
        const { evidenceHash } = await commander.assess(obligation.id);
        const approval = await commander.humanApproval({ obligationId: obligation.id, approver: deps.operator, note: input.note ?? "scheduled invoice run", evidenceHash });
        await gateway.submit(approval);
        return json({ id: obligation.id }, 201);
      }

      const match = path.match(/^\/api\/obligations\/([\w-]+)(?:\/([\w/-]+))?$/);
      if (!match) return json({ error: "NotFound", message: "no such route" }, 404);
      const id = match[1]!;
      const action = match[2];
      if (!ledger.getObligation(id)) return json({ error: "NotFound", message: "no such obligation" }, 404);

      if (request.method === "GET" && !action) return json(await view(id));
      if (request.method === "GET" && action === "certificate") {
        const stored = ledger.getCertificateJson(id);
        return stored ? new Response(stored, { headers: { "content-type": "application/json" } }) : json({ error: "NotFound", message: "not closed yet" }, 404);
      }
      if (request.method !== "POST") return json({ error: "MethodNotAllowed", message: "unsupported method" }, 405);

      const attemptAction = action?.match(/^attempts\/([\w-]+)\/resolve$/);
      if (attemptAction) {
        const attempt = ledger.getAttempt(attemptAction[1]!);
        if (!attempt || attempt.obligationId !== id) return json({ error: "NotFound", message: "no such attempt on this obligation" }, 404);
        const input = await body(request, NoteBody);
        const resolved = await gateway.resolveAttempt({ attemptId: attempt.id, by: deps.operator, note: input.note });
        return json({ attemptId: resolved.id, state: resolved.state });
      }

      switch (action) {
        case "replace": {
          const result = await commander
            .replaceAutomatically(id, effectiveEvidence(ledger.events(id), ledger.requireObligation(id).amountMinor)?.evidence ?? null)
            .catch(onRefusal(id, "replace"));
          return json({ outcome: result.outcome, attemptId: result.attempt.id }, 201);
        }
        case "approve": {
          const input = await body(request, ApproveBody);
          const result = await commander
            .humanApproval({
              obligationId: id, approver: deps.operator, note: input.note, evidenceHash: input.evidenceHash,
              evidence: effectiveEvidence(ledger.events(id), ledger.requireObligation(id).amountMinor)?.evidence ?? null,
              beneficiaryId: input.beneficiaryId, method: input.method, reason: input.reason,
            })
            .then((approval) => gateway.submit(approval))
            .catch(onRefusal(id, "approve"));
          return json({ outcome: result.outcome, attemptId: result.attempt.id }, 201);
        }
        case "fund": {
          const { result, replans } = await commander.fundAutomatically(id, effectiveEvidence(ledger.events(id), ledger.requireObligation(id).amountMinor)?.evidence ?? null).catch(onRefusal(id, "fund"));
          const funded: FundingResultWire = { outcome: result.outcome, conversion: result.conversion, walletsAfter: result.walletsAfter, replans };
          return json(funded, 201);
        }
        case "fund/quote": {
          const { plan, ...quote } = await commander.quoteForReview(id, effectiveEvidence(ledger.events(id), ledger.requireObligation(id).amountMinor)?.evidence ?? null).catch(onRefusal(id, "fund/quote"));
          const review: FundingQuote = { ...quote, plan };
          return json(review, 201);
        }
        case "fund/approve": {
          const input = await body(request, FundApproveBody);
          const result = await commander
            .approveFunding({
              obligationId: id, approver: deps.operator, note: input.note, evidenceHash: input.evidenceHash, quoteId: input.quoteId,
              fingerprint: input.fingerprint, evidence: effectiveEvidence(ledger.events(id), ledger.requireObligation(id).amountMinor)?.evidence ?? null,
            })
            .catch(onRefusal(id, "fund/approve"));
          const funded: FundingResultWire = { outcome: result.outcome, conversion: result.conversion, walletsAfter: result.walletsAfter, replans: [] };
          return json(funded, 201);
        }
        case "escalation/resolve": {
          const input = await body(request, NoteBody);
          const obligation = ledger.resolveEscalation(id, deps.operator, input.note);
          return json({ status: obligation.status });
        }
        case "inbox": {
          const input = await body(request, InboxBody);
          const eml = parseEml(input.email);
          const from = input.from ?? eml?.from ?? null;
          if (!from) return json({ error: "BadRequest", message: "say who sent the message (from), or upload the .eml with its From header" }, 400);
          const email = eml ? [eml.subject ? `Subject: ${eml.subject}` : null, eml.body].filter((l) => l !== null).join("\n\n") : input.email;
          if (email.trim().length === 0 || email.length > 20_000) {
            return json({ error: "BadRequest", message: "the message text must be between 1 and 20000 characters" }, 400);
          }
          const message = ledger.addInboxMessage({ incidentId: id, from, email, ...(input.statementText ? { statementText: input.statementText } : {}) });
          return json({ id: message.id }, 201);
        }
        case "recover": {
          const results = await gateway.recover(id);
          return json({ resolved: results.map((r) => ({ outcome: r.outcome, attemptId: r.attempt.id })) });
        }
        case "close": {
          // Same rule as the agent's close tool: the Closer proves the books tie, the Commander knows what is still disputed.
          await commander.assertCloseAllowed(id, effectiveEvidence(ledger.events(id), ledger.requireObligation(id).amountMinor)?.evidence ?? null);
          const certificate = await closer.close(id);
          return json({ hash: certificate.hash }, 200);
        }
        case "evidence": {
          const input = await body(request, ManualEvidenceBody);
          const obligation = ledger.requireObligation(id);
          const evidence = ExtractedEvidenceSchema.parse({
            claimsNonReceipt: input.claimsNonReceipt,
            requestsDetailChange: input.requestsDetailChange,
            referencesObligation: input.referencesObligation,
            containsEmbeddedInstructions: input.containsEmbeddedInstructions,
            statementCredit: input.statementCreditMinor === null ? null : { amountMinor: input.statementCreditMinor, currency: obligation.currency },
            summary: input.summary,
          });
          record(id, { ...evidence, adjustments: [`entered by ${deps.operator}`] }, "manual", null);
          return json({ ok: true }, 201);
        }
        case "evidence/read": {
          if (!deps.model) return json({ error: "ModelUnavailable", message: "no model is configured on this server" }, 503);
          const input = await body(request, ReadBody);
          const obligation = ledger.requireObligation(id);
          let email = input.email;
          let statementText = input.statementText;
          if (input.messageId !== undefined) {
            const stored = ledger.inboxMessages(id).find((m) => m.id === input.messageId);
            if (!stored) return json({ error: "NotFound", message: "no such message in this incident's inbox" }, 404);
            email = stored.email;
            statementText = stored.statementText;
          }
          const evidence = await readSupplierMessage(deps.model, {
            reference: obligation.reference, amountMinor: obligation.amountMinor, currency: obligation.currency,
            email: email!, statementText,
          });
          record(id, evidence, "model", { email: email!, ...(statementText !== undefined ? { statementText } : {}) }, input.messageId ?? null);
          return json({ evidence, messageHash: sha256Hex(email!) }, 201);
        }
        case "drafts/resolve": {
          const input = await body(request, ResolveDraftBody);
          const open = pendingDraft(ledger.events(id));
          if (!open || open.seq !== input.draftSeq) return json({ error: "Conflict", message: "that draft is no longer waiting for a person" }, 409);
          // Tessera sends nothing. SENT means a named person sent it outside Tessera and is saying so on the record.
          ledger.append(id, "DRAFT_RESOLVED", { draftSeq: input.draftSeq, resolution: input.resolution, by: deps.operator });
          return json({ ok: true });
        }
        case "simulate": {
          if (!deps.simulator) return json({ error: "NotFound", message: "sandbox controls are disabled" }, 404);
          const input = await body(request, SimulateBody);
          const latest = ledger.latestAttempt(id);
          if (!latest?.transferId) return json({ error: "Conflict", message: "no transfer to move" }, 409);
          try {
            await deps.simulator.advance(latest.transferId, input.status, input.failureType);
          } catch (error) {
            if (!(error instanceof AwxHttpError)) throw error;
            await gateway.sync(id);
            return json(
              {
                error: "SimulatorRefused",
                message: "Airwallex's simulator did not accept that step, usually because the transfer is mid-update or has already moved on. Check its current state and try again.",
              },
              409,
            );
          }
          await gateway.sync(id);
          return json({ ok: true });
        }
        default:
          return json({ error: "NotFound", message: "no such action" }, 404);
      }
    } catch (error) {
      if (error instanceof PayloadTooLarge) return json({ error: "PayloadTooLarge", message: "request body too large" }, 413);
      if (error instanceof SyntaxError) return json({ error: "BadRequest", message: "body is not valid JSON" }, 400);
      return problem(error);
    }
  };
}
