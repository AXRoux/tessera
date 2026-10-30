import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { WRITTEN_NOTE_MIN_CHARS } from "../approval/approval";
import { AwxHttpError } from "../airwallex/types";
import { verifyWebhook } from "../airwallex/webhook";
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
  DuplicateLockError,
  LedgerMismatchError,
  NotClosable,
  ObligationNotPayable,
  ReplacementDenied,
  StateConflict,
  WebhookRejected,
} from "../errors";
import { seedAcme } from "../demo/scenario";
import type { PayoutGateway } from "../gateway/gateway";
import type { Ledger, Obligation } from "../ledger/ledger";
import { toMinor } from "../money";
import { EmlNotPlainText, parseEml } from "./eml";
import { computeMetrics } from "./metrics";
import type { AgentStreamEvent, Health, IncidentSummary, IncidentView, SeedResult } from "./wire";

/** Sandbox or offline only: moves a transfer through Airwallex's simulator (or the fake's). Kept behind one interface so it can be removed. */
export interface Simulator {
  advance(transferId: string, status: string, failureType?: string): Promise<void>;
}

/** The model that drives the console's agent runs. Null or absent means the run endpoint answers 503. */
export interface AgentDeps {
  model: AgentModel;
  /** Names the agent in the ledger and the console, e.g. "agent:claude". */
  actor: string;
  /** Claude, or the deterministic scripted agent (src/demo/scripted-agent.ts). Shown to the operator as such. */
  kind: "claude" | "scripted";
  /** Fixed model-turn ceiling; absent means it scales with the open incidents in scope. */
  maxSteps?: number;
}

export interface ApiDeps {
  ledger: Ledger;
  gateway: PayoutGateway;
  commander: Commander;
  closer: Closer;
  /** Null when no model is configured; the reader endpoint then answers 503. */
  model: StructuredModel | null;
  simulator: Simulator | null;
  /** Shared secret for the single operator session; the Next.js server holds it, browsers never do. */
  token: string;
  /** Identity stamped on every human approval. Authentication of a person happens upstream of this API. */
  operator: string;
  beneficiaryId: string;
  paidHoldMs: number;
  /** Largest obligation this sandbox API will create, in major units. */
  maxAmount?: number;
  agent?: AgentDeps | null;
  /** Airwallex is the in-process simulator: no money, no network. */
  offline?: boolean;
  /** Endpoint secret for POST /api/webhooks/airwallex. Absent means the route answers 404. */
  webhookSecret?: string | null;
}

const MAX_BODY_BYTES = 64 * 1024;
const EVENT_WINDOW = 80;

const CreateBody = z.object({
  amount: z.number().positive().default(25),
  reference: z.string().min(1).max(40).optional(),
});
const WrittenNote = z
  .string()
  .trim()
  .min(WRITTEN_NOTE_MIN_CHARS, `write a note of at least ${WRITTEN_NOTE_MIN_CHARS} characters explaining the action`)
  .max(500);
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
const AgentRunBody = z.object({ incidentId: z.string().min(1).max(64).optional(), mode: z.enum(["commander", "adversary"]).default("commander") });
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

const json = (body: unknown, status = 200): Response => Response.json(body, { status, headers: { "cache-control": "no-store" } });

const KNOWN: Array<[new (...args: never[]) => Error, number]> = [
  [DuplicateLockError, 409],
  [ReplacementDenied, 409],
  [AutoReplacementRefused, 409],
  [ApprovalRejected, 409],
  [ObligationNotPayable, 409],
  [LedgerMismatchError, 409],
  [StateConflict, 409],
];

/** Refusals of a money-moving request. Raised on /replace or /approve, each is written to the ledger as PAYMENT_REFUSED. */
const PAYMENT_REFUSALS: Array<new (...args: never[]) => Error> = [
  AutoReplacementRefused, ReplacementDenied, DuplicateLockError, ApprovalRejected, ObligationNotPayable,
];

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

function problem(error: unknown): Response {
  if (error instanceof NotClosable) return json({ error: error.name, message: error.message, blockers: error.blockers }, 409);
  if (error instanceof AutoReplacementRefused) {
    return json({ error: error.name, message: error.message, reasons: error.decision.reasons }, 409);
  }
  if (error instanceof ApprovalRejected) return json({ error: error.name, message: error.message, code: error.reason }, 409);
  if (error instanceof z.ZodError) return json({ error: "BadRequest", message: z.prettifyError(error) }, 400);
  if (error instanceof EmlNotPlainText) return json({ error: "BadRequest", message: error.message }, 400);
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

  const summary = (o: Obligation): IncidentSummary => {
    const attempts = ledger.attemptsFor(o.id);
    const latest = attempts.at(-1);
    return {
      id: o.id, reference: o.reference, amountMinor: o.amountMinor, currency: o.currency, method: o.method,
      status: o.status, attemptCount: attempts.length, updatedAt: o.updatedAt,
      latest: latest ? { seq: latest.seq, state: latest.state, awxStatus: latest.awxStatus, failureCode: latest.failureCode } : null,
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
  const onRefusal = (obligationId: string, route: "replace" | "approve") => (error: unknown): never => {
    if (error instanceof Error && PAYMENT_REFUSALS.some((type) => error instanceof type)) {
      ledger.append(obligationId, "PAYMENT_REFUSED", { by: deps.operator, route, error: error.name, message: error.message.slice(0, 300) });
    }
    throw error;
  };

  let agentRunning = false;

  /** Streams an agent run as server-sent events. One run at a time: two agents on one ledger help nobody. */
  async function startAgentRun(request: Request): Promise<Response> {
    const agent = deps.agent;
    if (!agent) return json({ error: "ModelUnavailable", message: "no model is configured on this server" }, 503);
    if (agentRunning) return json({ error: "Conflict", message: "an agent run is already in progress" }, 409);
    // Claimed before the first await: two requests arriving together must not both pass the check above.
    agentRunning = true;
    let streaming = false;
    try {
      const response = await openAgentStream(request, agent);
      // Only a started stream owns the flag (its own finally releases it); every other answer releases it here.
      streaming = response.headers.get("content-type") === "text/event-stream";
      return response;
    } finally {
      if (!streaming) agentRunning = false;
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
    if (input.incidentId) {
      const target = ledger.getObligation(input.incidentId);
      if (!target) return json({ error: "NotFound", message: "no such obligation" }, 404);
      scope = new Set([target.id]);
      scopeLabel = target.reference;
    }
    // Room for every open incident in scope: about three model turns and six tool calls each.
    const open = ledger.listObligations().filter((o) => o.status !== "CLOSED" && (!scope || scope.has(o.id))).length;
    const maxSteps = adversary ? 24 : (agent.maxSteps ?? clamp(4 + 3 * open, 16, 48));
    const maxCalls = clamp(10 + 6 * open, 40, 300);

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
            acceptClientText: false, ...(scope ? { scope } : {}),
          });
          const task = adversary
            ? adversaryTask(scopeLabel)
            : scopeLabel
              ? `Work incident ${scopeLabel} only. Do not touch any other incident. Report in one or two sentences.`
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
          agentRunning = false;
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

  /**
   * Airwallex webhooks are hints: verified by signature, deduplicated by event id, then the transfer is re-read from
   * Airwallex like any sync. A sync failure still answers 200 (the background sweep catches up), so Airwallex does not
   * retry a delivery that was received.
   */
  async function webhook(request: Request): Promise<Response> {
    if (!deps.webhookSecret) return json({ error: "NotFound", message: "no such route" }, 404);
    if (request.method !== "POST") return json({ error: "MethodNotAllowed", message: "unsupported method" }, 405);
    const rawBody = await request.text();
    if (rawBody.length > MAX_BODY_BYTES) throw new PayloadTooLarge();
    let event;
    try {
      event = verifyWebhook({
        secret: deps.webhookSecret, timestamp: request.headers.get("x-timestamp"), signature: request.headers.get("x-signature"), rawBody,
      });
    } catch (error) {
      if (!(error instanceof WebhookRejected)) throw error;
      return json({ error: error.name, message: error.message }, error.reason === "malformed" ? 400 : 401);
    }
    const first = ledger.recordWebhookEvent(event);
    if (!first) return json({ ok: true, duplicate: true });
    if (event.transferId) {
      try {
        await gateway.syncTransfer(event.transferId);
      } catch (error) {
        console.error("webhook sync failed; the sweep will retry", error instanceof Error ? error.message : error);
      }
    }
    return json({ ok: true, duplicate: false });
  }

  return async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      // Authenticated by Airwallex's signature, not the operator token: Airwallex cannot hold our token.
      if (path === "/api/webhooks/airwallex") return await webhook(request);
      if (!authorized(request)) return json({ error: "Unauthorized", message: "missing or invalid token" }, 401);

      if (request.method === "GET" && path === "/api/health") {
        const health: Health = {
          ok: true, model: deps.model !== null, sandbox: deps.simulator !== null, offline: deps.offline ?? false,
          webhooks: Boolean(deps.webhookSecret), operator: deps.operator, agent: deps.agent?.kind ?? null,
        };
        return json(health);
      }
      if (request.method === "GET" && path === "/api/metrics") return json(computeMetrics(ledger));
      if (request.method === "POST" && path === "/api/demo/seed") {
        // Demo incidents move simulated or sandbox money only; against production there is no simulator and no seeding.
        if (!deps.simulator) return json({ error: "Forbidden", message: "demo incidents can be seeded only offline or against the Airwallex sandbox" }, 403);
        const seeded = await seedAcme({ ledger, gateway, commander, simulator: deps.simulator, approver: deps.operator }, deps.beneficiaryId);
        const result: SeedResult = { seeded: seeded.map(({ id, reference, expected }) => ({ id, reference, expected })) };
        return json(result, 201);
      }
      if (request.method === "POST" && path === "/api/agent/run") return await startAgentRun(request);
      if (request.method === "GET" && path === "/api/obligations") {
        return json({ items: ledger.listObligations().map(summary).toReversed() });
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
        const approval = await commander.humanApproval({ obligationId: obligation.id, approver: deps.operator, note: "scheduled invoice run", evidenceHash });
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
