import { describe, expect, it } from "bun:test";
import type { z } from "zod";
import failureCodes from "../fixtures/failure-codes.json";
import { AwxHttpError, AwxNetworkError } from "../src/airwallex/types";
import { Closer } from "../src/closer/closer";
import { Commander } from "../src/commander/commander";
import { DEFAULT_POLICY } from "../src/commander/policy";
import type { ExtractRequest, StructuredModel } from "../src/commander/evidence";
import { createHmac } from "node:crypto";
import { createToolbox } from "../src/agent/toolbox";
import type { AgentModel } from "../src/agent/loop";
import { createApi, MAX_REQUEST_BODY_BYTES, type ApiDeps, type Simulator } from "../src/server/api";
import { resettable } from "../src/server/resettable";
import {
  AttemptResolvedSchema,
  EscalationResolvedSchema,
  HealthSchema,
  IncidentListSchema,
  IncidentViewSchema,
  InboxCreatedSchema,
  MetricsSchema,
  ProblemSchema,
  SeedResultSchema,
} from "../src/server/wire";
import { FakePayoutApi } from "../src/airwallex/fake";
import { SECRET, world, type World } from "./helpers/world";

const TOKEN = "operator-token-for-tests";

/** Returns one scripted extraction for every call. */
class ScriptedModel implements StructuredModel {
  constructor(private readonly answer: unknown) {}
  async extract<T>(request: ExtractRequest<T>): Promise<T> {
    return request.schema.parse(this.answer);
  }
}

/** Mirrors the sandbox simulator: FAILED flips to CANCELLED straight away, carrying the failure code. */
function simulatorFor(api: FakePayoutApi): Simulator {
  return {
    async advance(transferId, status, failureType) {
      if (status !== "FAILED") return api.advance(transferId, status);
      const code = failureCodes.find((row) => row.failureType === failureType)?.code;
      api.advance(transferId, "FAILED", code);
      api.advance(transferId, "CANCELLED", code);
    },
    async stageWallet(currency, availableMajor) {
      api.balances.set(currency, availableMajor);
    },
  };
}

/** A wire response. `get` walks a dotted path through the JSON and returns unknown, so assertions stay unchecked-cast free. */
class Reply {
  constructor(readonly status: number, private readonly data: unknown) {}

  /** Parses the whole body with a wire schema, the way the web app does. Throws if the server drifts from the contract. */
  parse<S extends z.ZodType>(schema: S): z.infer<S> {
    return schema.parse(this.data);
  }

  get(path: string): unknown {
    let current: unknown = this.data;
    for (const key of path.split(".")) {
      if (current === null || typeof current !== "object" || !(key in current)) return undefined;
      current = Reflect.get(current, key);
    }
    return current;
  }
}

interface ApiWorld extends World {
  handle(request: Request): Promise<Response>;
  call(method: string, path: string, body?: unknown, token?: string | null, headers?: Record<string, string>): Promise<Reply>;
}

function apiWorld(
  options: { paidHoldMs?: number; model?: StructuredModel | null; simulator?: (api: FakePayoutApi) => Simulator; deps?: Partial<ApiDeps> } = {},
): ApiWorld {
  const w = world();
  // One hold window for both, as in the runtime: what the Commander waits for is what the Closer enforces.
  const commander = new Commander({ ledger: w.ledger, gateway: w.gateway, balances: w.api, secret: SECRET, policy: { ...DEFAULT_POLICY, paidHoldMs: options.paidHoldMs ?? 0 } });
  const closer = new Closer({ ledger: w.ledger, api: w.api, gateway: w.gateway, secret: SECRET, paidHoldMs: options.paidHoldMs ?? 0 });
  const handle = createApi({
    ledger: w.ledger, gateway: w.gateway, commander, closer,
    model: options.model ?? null, simulator: options.simulator?.(w.api) ?? simulatorFor(w.api),
    token: TOKEN, operator: "ops@acme.example", beneficiaryId: "ben-A", eurBeneficiaryId: "ben-B", paidHoldMs: options.paidHoldMs ?? 0,
    ...options.deps,
  });
  return {
    ...w,
    handle,
    async call(method, path, body, token = TOKEN, extraHeaders: Record<string, string> = {}) {
      const headers: Record<string, string> = { "content-type": "application/json", ...extraHeaders };
      if (token !== null) headers["x-tessera-token"] = token;
      const init: RequestInit = { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) };
      const response = await handle(new Request(`http://api.test${path}`, init));
      return new Reply(response.status, await response.json().catch(() => null));
    },
  };
}

async function openIncident(a: ApiWorld): Promise<string> {
  const created = await a.call("POST", "/api/obligations", { amount: 25 });
  expect(created.status).toBe(201);
  return String(created.get("id"));
}

describe("access", () => {
  it("refuses requests without the operator token", async () => {
    const a = apiWorld();

    expect((await a.call("GET", "/api/obligations", undefined, null)).status).toBe(401);
    expect((await a.call("GET", "/api/obligations", undefined, "wrong-token")).status).toBe(401);
  });

  it("rejects an oversized body", async () => {
    const a = apiWorld();
    const id = await openIncident(a);

    expect((await a.call("POST", `/api/obligations/${id}/approve`, { note: "x".repeat(70_000) })).status).toBe(413);
  });

  it("rejects malformed JSON", async () => {
    const a = apiWorld();
    const id = await openIncident(a);
    const handle = createApi({
      ledger: a.ledger, gateway: a.gateway,
      commander: new Commander({ ledger: a.ledger, gateway: a.gateway, balances: a.api, secret: SECRET }),
      closer: new Closer({ ledger: a.ledger, api: a.api, gateway: a.gateway, secret: SECRET }),
      model: null, simulator: null, token: TOKEN, operator: "ops", beneficiaryId: "ben-A", paidHoldMs: 0,
    });

    const response = await handle(
      new Request(`http://api.test/api/obligations/${id}/approve`, { method: "POST", headers: { "x-tessera-token": TOKEN }, body: "{not json" }),
    );

    expect(response.status).toBe(400);
  });
});

describe("incidents", () => {
  it("pays a new obligation exactly once and lists it as processing", async () => {
    const a = apiWorld();

    const id = await openIncident(a);

    expect(a.api.all).toHaveLength(1);
    const list = await a.call("GET", "/api/obligations");
    expect(list.get("items")).toContainEqual(
      expect.objectContaining({ id, status: "PAYING", attemptCount: 1, latest: expect.objectContaining({ state: "LIVE" }) }),
    );
  });

  it("never gives two invoices the same reference, because the Closer finds stray payments by reference", async () => {
    const a = apiWorld();

    const ids = await Promise.all(Array.from({ length: 25 }, () => openIncident(a)));
    const refs = ids.map((id) => a.ledger.requireObligation(id).reference);

    expect(new Set(refs).size).toBe(25);
    const reused = await a.call("POST", "/api/obligations", { amount: 25, reference: refs[0] });
    expect(reused.status).toBe(409);
    expect(a.api.all).toHaveLength(25);
  });

  it("tells the operator to wait, and when to look again, while the transfer is inside its window", async () => {
    const a = apiWorld();
    const id = await openIncident(a);

    const view = await a.call("GET", `/api/obligations/${id}`);

    expect(view.get("assessment.decision.recommended")).toBe("WAIT");
    expect(view.get("assessment.decision.recheckAt")).toBeString();
    expect(view.get("chain.ok")).toBe(true);
  });

  it("returns 404 for an unknown obligation", async () => {
    const a = apiWorld();

    expect((await a.call("GET", "/api/obligations/does-not-exist")).status).toBe(404);
  });

  it("answers 409 when the simulator refuses a step, and records where the transfer really is", async () => {
    // The sandbox advances transfers by itself, so a manual step can arrive after it has already moved on.
    const a = apiWorld({
      simulator: (api) => ({
        async advance(transferId) {
          api.advance(transferId, "PAID");
          throw new AwxHttpError(500, "operation_failed", "Request could not be processed", {});
        },
      }),
    });
    const id = await openIncident(a);

    const refused = await a.call("POST", `/api/obligations/${id}/simulate`, { status: "SENT" });

    expect(refused.status).toBe(409);
    expect(a.ledger.latestAttempt(id)?.state).toBe("PAID");
  });
});

describe("actions", () => {
  it("replaces automatically after a transient failure, under a new attempt", async () => {
    const a = apiWorld();
    const id = await openIncident(a);
    await a.call("POST", `/api/obligations/${id}/simulate`, { status: "FAILED", failureType: "CHANNEL_TIMEOUT" });

    const replaced = await a.call("POST", `/api/obligations/${id}/replace`);

    expect(replaced.status).toBe(201);
    expect(a.ledger.attemptsFor(id)).toHaveLength(2);
  });

  it("refuses a possible duplicate with the reasons, and makes no second payment", async () => {
    const a = apiWorld();
    const id = await openIncident(a);
    await a.call("POST", `/api/obligations/${id}/simulate`, { status: "FAILED", failureType: "DUPLICATION_RETURN" });

    const refused = await a.call("POST", `/api/obligations/${id}/replace`);

    expect(refused.status).toBe(409);
    expect(refused.get("reasons")).toEqual(expect.arrayContaining([expect.any(String)]));
    expect(a.ledger.attemptsFor(id)).toHaveLength(1);
  });

  it("releases a possible duplicate only for a real written reason, stamped with the operator", async () => {
    const a = apiWorld();
    const id = await openIncident(a);
    await a.call("POST", `/api/obligations/${id}/simulate`, { status: "FAILED", failureType: "DUPLICATION_RETURN" });

    const evidenceHash = String((await a.call("GET", `/api/obligations/${id}`)).get("assessment.evidenceHash"));
    const vague = await a.call("POST", `/api/obligations/${id}/approve`, { note: "ok", evidenceHash });
    expect(vague.status).toBe(400);

    const stale = await a.call("POST", `/api/obligations/${id}/approve`, { note: "supplier bank confirmed no credit by callback", evidenceHash: "0".repeat(64) });
    expect(stale.status).not.toBe(201);
    expect(a.ledger.attemptsFor(id)).toHaveLength(1);

    const real = await a.call("POST", `/api/obligations/${id}/approve`, { note: "supplier bank confirmed no credit by callback", evidenceHash });
    expect(real.status).toBe(201);
    const intent = a.ledger.events(id).filter((e) => e.type === "ATTEMPT_INTENT").at(-1)!;
    expect(intent.payload).toMatchObject({ mode: "HUMAN", approver: "ops@acme.example" });
  });

  it("refuses to close inside the hold window, naming the blocker", async () => {
    const a = apiWorld({ paidHoldMs: 3_600_000 });
    const id = await openIncident(a);
    await a.call("POST", `/api/obligations/${id}/simulate`, { status: "PAID" });

    const blocked = await a.call("POST", `/api/obligations/${id}/close`);

    expect(blocked.status).toBe(409);
    expect(blocked.get("blockers")).toContainEqual(expect.stringMatching(/^Paid is not final/));
  });

  it("refuses an operator's close while the supplier is disputing receipt, and allows it once the operator records that it is settled", async () => {
    const a = apiWorld();
    const id = await openIncident(a);
    await a.call("POST", `/api/obligations/${id}/simulate`, { status: "PAID" });
    const evidence = (claimsNonReceipt: boolean) => ({
      claimsNonReceipt, requestsDetailChange: false, referencesObligation: true, containsEmbeddedInstructions: false,
      statementCreditMinor: null, summary: claimsNonReceipt ? "supplier says nothing arrived" : "supplier confirmed receipt by phone",
    });

    await a.call("POST", `/api/obligations/${id}/evidence`, evidence(true));
    const refused = await a.call("POST", `/api/obligations/${id}/close`);

    expect(refused.status).toBe(409);
    expect(refused.get("blockers")).toContainEqual(expect.stringMatching(/does not allow closing/));
    expect(a.ledger.getCertificateJson(id)).toBeNull();

    await a.call("POST", `/api/obligations/${id}/evidence`, evidence(false));
    expect((await a.call("POST", `/api/obligations/${id}/close`)).status).toBe(200);
  });

  it("closes a reconciled payment and serves a certificate that matches", async () => {
    const a = apiWorld();
    const id = await openIncident(a);
    await a.call("POST", `/api/obligations/${id}/simulate`, { status: "PAID" });

    const closed = await a.call("POST", `/api/obligations/${id}/close`);
    const certificate = await a.call("GET", `/api/obligations/${id}/certificate`);
    const view = await a.call("GET", `/api/obligations/${id}`);

    expect(closed.status).toBe(200);
    expect(certificate.get("hash")).toBe(closed.get("hash"));
    expect(view.get("obligation.status")).toBe("CLOSED");
    expect(view.get("certificate.hash")).toBe(closed.get("hash"));
  });
});

describe("wire contract", () => {
  it("serves health, the list, an open incident and a closed incident that the web app's schemas accept", async () => {
    const a = apiWorld();
    const id = await openIncident(a);

    (await a.call("GET", "/api/health")).parse(HealthSchema);
    expect((await a.call("GET", "/api/obligations")).parse(IncidentListSchema).items.length).toBeGreaterThan(0);
    expect((await a.call("GET", `/api/obligations/${id}`)).parse(IncidentViewSchema).certificate).toBeNull();

    await a.call("POST", `/api/obligations/${id}/simulate`, { status: "PAID" });
    await a.call("POST", `/api/obligations/${id}/close`);
    const closed = (await a.call("GET", `/api/obligations/${id}`)).parse(IncidentViewSchema);

    expect(closed.certificate?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(closed.obligation.status).toBe("CLOSED");
  });

  it("serves every refusal as a problem with the sentences a person needs", async () => {
    const a = apiWorld({ paidHoldMs: 3_600_000 });
    const id = await openIncident(a);
    await a.call("POST", `/api/obligations/${id}/simulate`, { status: "FAILED", failureType: "DUPLICATION_RETURN" });

    const refused = (await a.call("POST", `/api/obligations/${id}/replace`)).parse(ProblemSchema);
    expect(refused.reasons?.length).toBeGreaterThan(0);

    const other = await openIncident(a);
    await a.call("POST", `/api/obligations/${other}/simulate`, { status: "PAID" });
    const blocked = (await a.call("POST", `/api/obligations/${other}/close`)).parse(ProblemSchema);
    expect(blocked.blockers?.length).toBeGreaterThan(0);

    (await a.call("GET", "/api/obligations/missing")).parse(ProblemSchema);
    (await a.call("GET", "/api/obligations", undefined, null)).parse(ProblemSchema);
  });
});

describe("supplier evidence", () => {
  it("records what the operator reports, and it changes the decision on the next read", async () => {
    const a = apiWorld();
    const id = await openIncident(a);
    await a.call("POST", `/api/obligations/${id}/simulate`, { status: "FAILED", failureType: "CHANNEL_TIMEOUT" });
    const before = await a.call("GET", `/api/obligations/${id}`);
    expect(before.get("assessment.decision.recommended")).toBe("REPLACE");

    await a.call("POST", `/api/obligations/${id}/evidence`, {
      claimsNonReceipt: false, requestsDetailChange: false, referencesObligation: true,
      containsEmbeddedInstructions: false, statementCreditMinor: 2_500, summary: "supplier's statement shows our credit",
    });
    const after = await a.call("GET", `/api/obligations/${id}`);

    expect(after.get("evidence.source")).toBe("manual");
    expect(after.get("assessment.decision.recommended")).toBe("ESCALATE");
    expect(after.get("assessment.decision.severity")).toBe("CRITICAL");
  });

  it("reads a supplier's message with the model, records its provenance, and escalates a detail-change request", async () => {
    const model = new ScriptedModel({
      claimsNonReceipt: false, requestsDetailChange: true, referencesObligation: true, statementCredit: null,
      containsEmbeddedInstructions: false, summary: "supplier asks to pay a new account",
    });
    const a = apiWorld({ model });
    const id = await openIncident(a);
    const reference = a.ledger.requireObligation(id).reference;

    const read = await a.call("POST", `/api/obligations/${id}/evidence/read`, { email: `Re ${reference}: please use our new bank account from now on.` });
    const view = await a.call("GET", `/api/obligations/${id}`);

    expect(read.status).toBe(201);
    expect(view.get("evidence.source")).toBe("model");
    expect(view.get("evidence.enteredBy")).toBe("ops@acme.example");
    expect(view.get("assessment.decision.recommended")).toBe("ESCALATE");
  });

  it("answers 503 when no model is configured", async () => {
    const a = apiWorld({ model: null });
    const id = await openIncident(a);

    expect((await a.call("POST", `/api/obligations/${id}/evidence/read`, { email: "hello" })).status).toBe(503);
  });
});

describe("approval against what the operator saw", () => {
  it("refuses an approval of a stale assessment with 409 stale_evidence, on the record, and pays nothing", async () => {
    const a = apiWorld();
    const id = await openIncident(a);
    await a.call("POST", `/api/obligations/${id}/simulate`, { status: "FAILED", failureType: "DUPLICATION_RETURN" });
    const seen = (await a.call("GET", `/api/obligations/${id}`)).parse(IncidentViewSchema);
    expect(seen.evidenceHash).toBe(seen.assessment!.evidenceHash);

    // The facts move after the operator looked: a manual statement credit changes the assessment.
    await a.call("POST", `/api/obligations/${id}/evidence`, {
      claimsNonReceipt: false, requestsDetailChange: false, referencesObligation: true,
      containsEmbeddedInstructions: false, statementCreditMinor: 2_500, summary: "statement shows the credit",
    });
    const stale = await a.call("POST", `/api/obligations/${id}/approve`, { note: "supplier confirmed nothing arrived by phone", evidenceHash: seen.evidenceHash });

    expect(stale.status).toBe(409);
    expect(stale.parse(ProblemSchema).code).toBe("stale_evidence");
    expect(a.ledger.attemptsFor(id)).toHaveLength(1);
    expect(a.ledger.events(id).at(-1)).toMatchObject({ type: "PAYMENT_REFUSED", payload: { by: "ops@acme.example", route: "approve", error: "ApprovalRejected" } });
  });
});

describe("human releases", () => {
  it("resolves an escalation only with a written note, then re-derives the status", async () => {
    const a = apiWorld();
    const id = await openIncident(a);
    a.ledger.escalate(id, "agent:test: unsure");

    expect((await a.call("POST", `/api/obligations/${id}/escalation/resolve`, { note: "ok" })).status).toBe(400);
    const resolved = await a.call("POST", `/api/obligations/${id}/escalation/resolve`, { note: "called the supplier, the payment is fine" });

    expect(resolved.status).toBe(200);
    expect(resolved.parse(EscalationResolvedSchema).status).toBe("PAYING");
    expect(a.ledger.events(id).some((e) => e.type === "ESCALATION_RESOLVED")).toBe(true);
    expect((await a.call("POST", `/api/obligations/${id}/escalation/resolve`, { note: "called the supplier, the payment is fine" })).status).toBe(409);
  });

  it("releases an attempt's lock only once Airwallex shows it CANCELLED, never while it is only held in an approval state", async () => {
    const a = apiWorld();
    const id = await openIncident(a);
    const other = await openIncident(a);
    const attempt = a.ledger.latestAttempt(id)!;
    const note = { note: "Airwallex support confirmed the rejection" };

    expect((await a.call("POST", `/api/obligations/${id}/attempts/${attempt.id}/resolve`, note)).status).toBe(409);
    expect((await a.call("POST", `/api/obligations/${other}/attempts/${attempt.id}/resolve`, note)).status).toBe(404);
    // Airwallex documents APPROVAL_REJECTED as resumable (-> IN_APPROVAL): the transfer can still pay.
    a.api.advance(attempt.transferId!, "APPROVAL_REJECTED");
    expect((await a.call("POST", `/api/obligations/${id}/attempts/${attempt.id}/resolve`, note)).status).toBe(409);
    expect(a.ledger.requireAttempt(attempt.id).state).toBe("LIVE");

    a.api.advance(attempt.transferId!, "CANCELLED");
    const released = await a.call("POST", `/api/obligations/${id}/attempts/${attempt.id}/resolve`, note);

    expect(released.status).toBe(200);
    expect(released.parse(AttemptResolvedSchema)).toEqual({ attemptId: attempt.id, state: "DEAD" });
  });
});

describe("supplier inbox", () => {
  it("files pasted text and .eml uploads, and marks a message read once the reader has it by id", async () => {
    const model = new ScriptedModel({
      claimsNonReceipt: true, requestsDetailChange: false, referencesObligation: false, statementCredit: null,
      containsEmbeddedInstructions: false, summary: "says it has not arrived",
    });
    const a = apiWorld({ model });
    const id = await openIncident(a);

    const pasted = await a.call("POST", `/api/obligations/${id}/inbox`, { from: "ar@northwind.example", email: "It has not arrived yet." });
    const eml = await a.call("POST", `/api/obligations/${id}/inbox`, { email: "From: Priya <ar@northwind.example>\nSubject: Where is it\n\nStill nothing." });
    const anonymous = await a.call("POST", `/api/obligations/${id}/inbox`, { email: "no sender here" });
    const html = await a.call("POST", `/api/obligations/${id}/inbox`, { email: "From: a@b.example\nContent-Type: text/html\n\n<p>x</p>" });

    expect(pasted.status).toBe(201);
    expect(anonymous.status).toBe(400);
    expect(html.status).toBe(400);
    const messageId = pasted.parse(InboxCreatedSchema).id;
    const uploaded = a.ledger.inboxMessages(id).find((m) => m.id === eml.parse(InboxCreatedSchema).id)!;
    expect(uploaded).toMatchObject({ from: "ar@northwind.example", email: "Subject: Where is it\n\nStill nothing." });

    expect((await a.call("POST", `/api/obligations/${id}/evidence/read`, { messageId })).status).toBe(201);
    const view = (await a.call("GET", `/api/obligations/${id}`)).parse(IncidentViewSchema);

    expect(Object.fromEntries(view.inbox.map((m) => [m.id, m.read]))).toEqual({ [messageId]: true, [uploaded.id]: false });
    expect(view.evidence?.evidence.claimsNonReceipt).toBe(true);
    expect((await a.call("POST", `/api/obligations/${id}/evidence/read`, { messageId: "nope" })).status).toBe(404);
  });
});

describe("request size, and no webhook route on the operator API", () => {
  it("does not serve Airwallex webhooks: they reach only the webhook-only listener, so the operator port never needs a tunnel", async () => {
    const a = apiWorld();
    const body = JSON.stringify({ id: "evt_1", name: "payout.transfer.paid", created_at: new Date().toISOString(), data: { id: "t" } });

    expect((await a.call("POST", "/api/webhooks/airwallex", body, null)).status).toBe(401);
    expect((await a.call("POST", "/api/webhooks/airwallex", body)).status).toBe(404);
  });

  it("14. the server caps request bodies far below Bun's 128 MB default, and above every legitimate route", async () => {
    let reached = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: MAX_REQUEST_BODY_BYTES, fetch: () => { reached++; return new Response("ok"); } });
    try {
      const huge = await fetch(`http://127.0.0.1:${server.port}/api/webhooks/airwallex`, { method: "POST", body: "x".repeat(1024 * 1024) });
      const roomy = await fetch(`http://127.0.0.1:${server.port}/`, { method: "POST", body: "x".repeat(150 * 1024) });

      expect(huge.status).toBe(413);
      expect(reached).toBe(1); // only the legitimately sized request got through
      expect(roomy.status).toBe(200);
    } finally {
      await server.stop(true);
    }
    expect(MAX_REQUEST_BODY_BYTES).toBeGreaterThan(2 * 20_000 * 4); // a full 20 000-char email plus statement, 4 bytes a character
  });
});

describe("demo seeding", () => {
  it("is forbidden where there is no simulator, so never against production", async () => {
    expect((await apiWorld({ deps: { simulator: null } }).call("POST", "/api/demo/seed")).status).toBe(403);
  });

  it("seeds the seven ACME incidents where the simulator is on", async () => {
    const a = apiWorld({ paidHoldMs: 3_600_000 });

    const seeded = (await a.call("POST", "/api/demo/seed")).parse(SeedResultSchema).seeded;

    expect(seeded.map((s) => s.reference.slice(0, 9))).toEqual(["ACME-1041", "ACME-1042", "ACME-1043", "ACME-1044", "ACME-1045", "ACME-1046", "ACME-1047"]);
    expect(a.ledger.inboxMessages()).toHaveLength(3);
    expect(a.ledger.latestAttempt(seeded[1]!.id)!.state).toBe("DEAD");
    expect(a.ledger.latestAttempt(seeded[6]!.id)!.state).toBe("DEAD");
  });

  it("answers 409 without an EUR supplier for the funding incident, and seeds nothing", async () => {
    const a = apiWorld({ deps: { eurBeneficiaryId: null } });

    expect((await a.call("POST", "/api/demo/seed")).status).toBe(409);
    expect(a.ledger.listObligations().filter((o) => o.reference.startsWith("ACME-"))).toEqual([]);
  });
});

describe("metrics", () => {
  it("counts refusals, money held back, replacements, escalations and time to certify from the ledger", async () => {
    const a = apiWorld();
    const duplicate = await openIncident(a);
    await a.call("POST", `/api/obligations/${duplicate}/simulate`, { status: "FAILED", failureType: "DUPLICATION_RETURN" });
    expect((await a.call("POST", `/api/obligations/${duplicate}/replace`)).status).toBe(409);
    a.ledger.escalate(duplicate, "possible duplicate");
    const transient = await openIncident(a);
    await a.call("POST", `/api/obligations/${transient}/simulate`, { status: "FAILED", failureType: "CHANNEL_TIMEOUT" });
    expect((await a.call("POST", `/api/obligations/${transient}/replace`)).status).toBe(201);
    expect((await a.call("POST", `/api/obligations/${transient}/replace`)).status).toBe(409);
    const paid = await openIncident(a);
    await a.call("POST", `/api/obligations/${paid}/simulate`, { status: "PAID" });
    await a.call("POST", `/api/obligations/${paid}/close`);

    const metrics = (await a.call("GET", "/api/metrics")).parse(MetricsSchema);

    expect(metrics).toMatchObject({
      incidents: 4, open: 3, escalated: 1, certified: 1, autoReplaced: 1, paymentsRefused: 2, refusedAmountMinor: { USD: 5_000 }, agentRefusals: 0,
    });
    expect(metrics.medianResolutionMs).toBeGreaterThanOrEqual(0);
  });

  it("reports health with the offline and agent flags the console shows", async () => {
    const scripted: AgentModel = { converse: async () => ({ content: [{ type: "text", text: "done" }], stopReason: "end_turn" }) };
    const health = (await apiWorld({ deps: { offline: true, agent: { model: scripted, actor: "agent:scripted", kind: "scripted" } } }).call("GET", "/api/health")).parse(HealthSchema);

    expect(health).toMatchObject({ offline: true, agent: "scripted", webhooks: false, sandbox: true });
  });
});

describe("one agent run at a time", () => {
  function gated() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const model: AgentModel = {
      async converse() {
        await gate;
        return { content: [{ type: "text", text: "done" }], stopReason: "end_turn" };
      },
    };
    return { model, release };
  }

  it("lets exactly one of two simultaneous runs start", async () => {
    const { model, release } = gated();
    const a = apiWorld({ deps: { agent: { model, actor: "agent:test", kind: "scripted" } } });

    const post = () =>
      a.handle(new Request("http://api.test/api/agent/run", { method: "POST", headers: { "x-tessera-token": TOKEN }, body: "{}" }));

    const [first, second] = await Promise.all([post(), post()]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    release();
    await Promise.all([first.text(), second.text()]);
  });

  it("frees the run when a request is refused before streaming", async () => {
    const { model, release } = gated();
    const a = apiWorld({ deps: { agent: { model, actor: "agent:test", kind: "scripted" } } });

    expect((await a.call("POST", "/api/agent/run", { incidentId: "missing" })).status).toBe(404);
    expect((await a.call("POST", "/api/agent/run", { mode: "nonsense" })).status).toBe(400);
    release();
    expect((await a.call("POST", "/api/agent/run", {})).status).toBe(200);
  });
});

describe("what the board is told about agents and people", () => {
  const agentOn = (a: ApiWorld) =>
    createToolbox({
      ledger: a.ledger, gateway: a.gateway, model: null, actor: "agent:test", acceptClientText: false,
      commander: new Commander({ ledger: a.ledger, gateway: a.gateway, balances: a.api, secret: SECRET, policy: { ...DEFAULT_POLICY, paidHoldMs: 0 } }),
      closer: new Closer({ ledger: a.ledger, api: a.api, gateway: a.gateway, secret: SECRET, paidHoldMs: 0 }),
    });
  const summaryOf = async (a: ApiWorld, id: string) =>
    (await a.call("GET", "/api/obligations")).parse(IncidentListSchema).items.find((i) => i.id === id)!;

  it("shows an agent's verdict, and why a person is needed once it hands the incident over", async () => {
    const a = apiWorld();
    const id = await openIncident(a);
    expect(await summaryOf(a, id)).toMatchObject({ lastAgentAction: null, attention: null });
    const agent = agentOn(a);

    await agent.call("assess_incident", { incidentId: id });
    expect((await summaryOf(a, id)).lastAgentAction).toBeNull();

    await agent.call("escalate_to_human", { incidentId: id, reason: "supplier disputes the amount" });
    const handed = await summaryOf(a, id);

    expect(handed.lastAgentAction).toMatchObject({ actor: "agent:test", tool: "escalate_to_human", outcome: "ok" });
    expect(handed.attention).toMatchObject({ kind: "ESCALATED", reason: expect.stringContaining("supplier disputes the amount") });
  });

  it("shows a refused attempt as the agent's last verdict, so a hostile agent is visible on the board", async () => {
    const a = apiWorld();
    const id = await openIncident(a);

    await agentOn(a).call("replace_payment", { incidentId: id });

    expect((await summaryOf(a, id)).lastAgentAction).toMatchObject({ tool: "replace_payment", outcome: "refused" });
  });

  it("asks for a decision when a failed payment is back in the wallet, and for a send when a reply is drafted", async () => {
    const a = apiWorld();
    const duplicate = await openIncident(a);
    await a.call("POST", `/api/obligations/${duplicate}/simulate`, { status: "FAILED", failureType: "DUPLICATION_RETURN" });

    expect((await summaryOf(a, duplicate)).attention).toMatchObject({ kind: "NEEDS_ACTION", reason: expect.stringContaining("91301") });

    const waiting = await openIncident(a);
    await agentOn(a).call("draft_supplier_reply", { incidentId: waiting, kind: "STATUS", message: "Thanks for getting in touch. The payment is still in transit and we are watching it." });

    expect((await summaryOf(a, waiting)).attention).toMatchObject({ kind: "DRAFT" });
  });
});

describe("starting the offline demo over", () => {
  const references = async (call: (method: string, path: string) => Promise<Response>) =>
    (await (await call("GET", "/api/obligations")).json() as { items: Array<{ reference: string }> }).items.map((i) => i.reference);

  it("throws the old state away, keeps the same operator token working, and can be seeded again", async () => {
    const demo = await resettable(async () => ({ handle: apiWorld({ deps: { reset: () => demo.reset() } }).handle, sweep: async () => {} }));
    const call = (method: string, path: string) => demo.handle(new Request(`http://api.test${path}`, { method, headers: { "x-tessera-token": TOKEN } }));

    expect((await call("POST", "/api/demo/seed")).status).toBe(201);
    expect((await references(call)).filter((r) => r.startsWith("ACME-"))).toHaveLength(7);

    expect((await call("POST", "/api/demo/reset")).status).toBe(200);
    expect((await references(call)).filter((r) => r.startsWith("ACME-"))).toHaveLength(0);

    expect((await call("POST", "/api/demo/seed")).status).toBe(201);
    expect((await references(call)).filter((r) => r.startsWith("ACME-"))).toHaveLength(7);
  });

  it("is refused where there is nothing to throw away, and says so in health", async () => {
    const live = apiWorld();

    expect((await live.call("POST", "/api/demo/reset")).status).toBe(403);
    expect((await live.call("GET", "/api/health")).parse(HealthSchema).canReset).toBe(false);
    expect((await apiWorld({ deps: { reset: async () => {} } }).call("GET", "/api/health")).parse(HealthSchema).canReset).toBe(true);
  });
});
