import { describe, expect, it } from "bun:test";
import type { z } from "zod";
import failureCodes from "../fixtures/failure-codes.json";
import { Closer } from "../src/closer/closer";
import { Commander } from "../src/commander/commander";
import type { ExtractRequest, StructuredModel } from "../src/commander/evidence";
import { createApi, type Simulator } from "../src/server/api";
import { HealthSchema, IncidentListSchema, IncidentViewSchema, ProblemSchema } from "../src/server/wire";
import { FakePayoutApi } from "./helpers/fake-awx";
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
  call(method: string, path: string, body?: unknown, token?: string | null): Promise<Reply>;
}

function apiWorld(options: { paidHoldMs?: number; model?: StructuredModel | null } = {}): ApiWorld {
  const w = world();
  const commander = new Commander({ ledger: w.ledger, gateway: w.gateway, balances: w.api, secret: SECRET });
  const closer = new Closer({ ledger: w.ledger, api: w.api, secret: SECRET, paidHoldMs: options.paidHoldMs ?? 0 });
  const handle = createApi({
    ledger: w.ledger, gateway: w.gateway, commander, closer,
    model: options.model ?? null, simulator: simulatorFor(w.api),
    token: TOKEN, operator: "ops@acme.example", beneficiaryId: "ben-A", paidHoldMs: options.paidHoldMs ?? 0,
  });
  return {
    ...w,
    async call(method, path, body, token = TOKEN) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (token !== null) headers["x-payonce-token"] = token;
      const init: RequestInit = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) };
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
      closer: new Closer({ ledger: a.ledger, api: a.api, secret: SECRET }),
      model: null, simulator: null, token: TOKEN, operator: "ops", beneficiaryId: "ben-A", paidHoldMs: 0,
    });

    const response = await handle(
      new Request(`http://api.test/api/obligations/${id}/approve`, { method: "POST", headers: { "x-payonce-token": TOKEN }, body: "{not json" }),
    );

    expect(response.status).toBe(400);
  });
});

describe("incidents", () => {
  it("pays a new obligation exactly once and lists it in flight", async () => {
    const a = apiWorld();

    const id = await openIncident(a);

    expect(a.api.all).toHaveLength(1);
    const list = await a.call("GET", "/api/obligations");
    expect(list.get("items")).toContainEqual(
      expect.objectContaining({ id, status: "PAYING", attemptCount: 1, latest: expect.objectContaining({ state: "LIVE" }) }),
    );
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

    const vague = await a.call("POST", `/api/obligations/${id}/approve`, { note: "ok" });
    expect(vague.status).toBe(409);

    const real = await a.call("POST", `/api/obligations/${id}/approve`, { note: "supplier bank confirmed no credit by callback" });
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
    expect(blocked.get("blockers")).toContainEqual(expect.stringMatching(/^PAID is not final/));
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
