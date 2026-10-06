import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { sha256Hex } from "../canonical";
import { SignedCertificateSchema } from "../closer/certificate";
import type { Closer } from "../closer/closer";
import type { Commander } from "../commander/commander";
import {
  ExtractedEvidenceSchema,
  latestEvidence,
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
} from "../errors";
import type { PayoutGateway } from "../gateway/gateway";
import type { Ledger, Obligation } from "../ledger/ledger";
import { toMinor } from "../money";
import type { IncidentSummary, IncidentView } from "./wire";

/** Sandbox-only: moves a transfer through Airwallex's simulator. Kept behind one interface so it can be removed. */
export interface Simulator {
  advance(transferId: string, status: string, failureType?: string): Promise<void>;
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
}

const MAX_BODY_BYTES = 64 * 1024;
const EVENT_WINDOW = 80;

const CreateBody = z.object({
  amount: z.number().positive().default(25),
  reference: z.string().min(1).max(40).optional(),
});
const ApproveBody = z.object({
  note: z.string().min(1).max(500),
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
const ReadBody = z.object({ email: z.string().min(1).max(20_000), statementText: z.string().max(20_000).optional() });
const SimulateBody = z.object({ status: z.enum(["SENT", "PAID", "FAILED"]), failureType: z.string().regex(/^[A-Z0-9_]+$/).optional() });

const json = (body: unknown, status = 200): Response => Response.json(body, { status, headers: { "cache-control": "no-store" } });

const KNOWN: Array<[new (...args: never[]) => Error, number]> = [
  [DuplicateLockError, 409],
  [ReplacementDenied, 409],
  [AutoReplacementRefused, 409],
  [ApprovalRejected, 409],
  [ObligationNotPayable, 409],
  [LedgerMismatchError, 409],
];

function problem(error: unknown): Response {
  if (error instanceof NotClosable) return json({ error: error.name, message: error.message, blockers: error.blockers }, 409);
  if (error instanceof AutoReplacementRefused) {
    return json({ error: error.name, message: error.message, reasons: error.decision.reasons }, 409);
  }
  if (error instanceof z.ZodError) return json({ error: "BadRequest", message: z.prettifyError(error) }, 400);
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

export function createApi(deps: ApiDeps): (request: Request) => Promise<Response> {
  const { ledger, gateway, commander, closer } = deps;

  const authorized = (request: Request): boolean => {
    const given = Buffer.from(request.headers.get("x-payonce-token") ?? "");
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
    const recorded = latestEvidence(events);
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
    return {
      obligation: ledger.requireObligation(id),
      attempts: ledger.attemptsFor(id),
      events: ledger.events(id).slice(-EVENT_WINDOW),
      evidence: recorded,
      assessment,
      assessmentError,
      certificate: stored ? SignedCertificateSchema.parse(JSON.parse(stored)) : null,
      chain: { ok: chain.ok, brokenAt: chain.ok ? null : chain.brokenAt },
      paidHoldMs: deps.paidHoldMs,
    };
  };

  const record = (obligationId: string, evidence: SupplierEvidence, source: "manual" | "model", message: { email: string; statementText?: string } | null) =>
    ledger.tx(() => ledger.append(obligationId, "EVIDENCE_RECORDED", { evidence, source, enteredBy: deps.operator, message }));

  return async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (!authorized(request)) return json({ error: "Unauthorized", message: "missing or invalid token" }, 401);

      if (request.method === "GET" && path === "/api/health") {
        return json({ ok: true, model: deps.model !== null, sandbox: deps.simulator !== null, operator: deps.operator });
      }
      if (request.method === "GET" && path === "/api/obligations") {
        return json({ items: ledger.listObligations().map(summary).toReversed() });
      }
      if (request.method === "POST" && path === "/api/obligations") {
        const input = await body(request, CreateBody);
        if (input.amount > (deps.maxAmount ?? 1_000)) return json({ error: "BadRequest", message: `amount above the sandbox limit of ${deps.maxAmount ?? 1_000}` }, 400);
        const obligation = ledger.createObligation({
          reference: input.reference ?? `INV-${Date.now().toString(36).toUpperCase()}`,
          beneficiaryId: deps.beneficiaryId,
          amountMinor: toMinor(input.amount, "USD"),
          currency: "USD",
          method: "LOCAL",
          reason: "professional_business_services",
        });
        const approval = await commander.humanApproval({ obligationId: obligation.id, approver: deps.operator, note: "scheduled invoice run" });
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

      switch (action) {
        case "replace": {
          const result = await commander.replaceAutomatically(id, latestEvidence(ledger.events(id))?.evidence ?? null);
          return json({ outcome: result.outcome, attemptId: result.attempt.id }, 201);
        }
        case "approve": {
          const input = await body(request, ApproveBody);
          const approval = await commander.humanApproval({
            obligationId: id, approver: deps.operator, note: input.note,
            evidence: latestEvidence(ledger.events(id))?.evidence ?? null,
            beneficiaryId: input.beneficiaryId, method: input.method, reason: input.reason,
          });
          const result = await gateway.submit(approval);
          return json({ outcome: result.outcome, attemptId: result.attempt.id }, 201);
        }
        case "recover": {
          const results = await gateway.recover();
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
          const evidence = await readSupplierMessage(deps.model, {
            reference: obligation.reference, amountMinor: obligation.amountMinor, currency: obligation.currency,
            email: input.email, statementText: input.statementText,
          });
          record(id, evidence, "model", { email: input.email, statementText: input.statementText });
          return json({ evidence, messageHash: sha256Hex(input.email) }, 201);
        }
        case "simulate": {
          if (!deps.simulator) return json({ error: "NotFound", message: "sandbox controls are disabled" }, 404);
          const input = await body(request, SimulateBody);
          const latest = ledger.latestAttempt(id);
          if (!latest?.transferId) return json({ error: "Conflict", message: "no transfer to move" }, 409);
          await deps.simulator.advance(latest.transferId, input.status, input.failureType);
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
