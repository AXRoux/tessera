import { describe, expect, it } from "bun:test";
import { COMMANDER_SYSTEM, runAgent } from "../src/agent/loop";
import { createToolbox } from "../src/agent/toolbox";
import { DEFAULT_POLICY, decide, type IncidentFacts } from "../src/commander/policy";
import { MORNING } from "../src/demo/morning";
import { ScriptedAgentModel } from "../src/demo/scripted-agent";
import { createApi } from "../src/server/api";
import { BankClock } from "../src/server/bank-clock";
import { buildRuntime } from "../src/server/runtime";
import { IncidentListSchema, MorningResultSchema, type IncidentSummary } from "../src/server/wire";

const TOKEN = "t".repeat(32);
const OPERATOR = "ops@acme.example";

/** The offline runtime behind the API, the way `bun run demo` serves it, with a bank clock whose time the test sets. */
function world() {
  const rt = buildRuntime({ TESSERA_OFFLINE: "1", TESSERA_PAID_HOLD_MS: "0", TESSERA_API_TOKEN: TOKEN });
  const handle = createApi({
    ledger: rt.ledger, gateway: rt.gateway, commander: rt.commander, closer: rt.closer, cards: rt.cards, model: rt.model, simulator: rt.simulator,
    token: TOKEN, operator: OPERATOR, beneficiaryId: "offline-us-supplier", paidHoldMs: 0, agent: rt.agent, offline: true, beneficiaries: rt.api, storyPollMs: 0,
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await handle(
      new Request(`http://api.test${path}`, { method, headers: { "x-tessera-token": TOKEN, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }),
    );
    return { status: response.status, data: (await response.json().catch(() => null)) as Record<string, unknown> };
  };
  let now = Date.now();
  const clock = new BankClock({ ledger: rt.ledger, gateway: rt.gateway, simulator: rt.simulator!, afterMs: 15_000, landsAfterMs: 30_000, now: () => now });
  const morning = async () => MorningResultSchema.parse((await call("POST", "/api/supplier-issues")).data).cases;
  const board = async () => IncidentListSchema.parse((await call("GET", "/api/obligations")).data).items;
  const lane = async (id: string): Promise<IncidentSummary> => (await board()).find((i) => i.id === id)!;
  /** The built-in agent over these invoices only, through the same toolbox and policy as the console's runs. */
  const agent = (ids: string[], actor = "agent:scripted") => {
    const toolbox = createToolbox({
      ledger: rt.ledger, gateway: rt.gateway, commander: rt.commander, closer: rt.closer, model: rt.model, actor, acceptClientText: false,
      scope: new Set(ids), cards: rt.cards,
    });
    return { toolbox, run: () => runAgent({ model: new ScriptedAgentModel(), toolbox, system: COMMANDER_SYSTEM, task: "Work these incidents only." }) };
  };
  const card = (id: string) => rt.ledger.invoiceCard(id);
  const types = (id: string) => rt.ledger.events(id).map((e) => e.type);
  return {
    rt, call, morning, board, lane, agent, card, types, clock,
    /** Moves the clock on by `ms` and lets the bank answer. */
    tick: async (ms: number) => {
      now += ms;
      await clock.tick();
    },
    /** Sets the clock `ms` after the present (the ledger stamps events in real time), and lets the bank answer. */
    at: async (ms: number) => {
      now = Date.now() + ms;
      await clock.tick();
    },
  };
}

describe("this morning: supplier payments already in motion and stuck", () => {
  it("sets up six cases through the ordinary path, each where its brief says, and wakes nobody", async () => {
    const w = world();
    const cases = await w.morning();
    expect(cases.map((c) => c.supplier)).toEqual(["Modal", "Prime Intellect", "Replicate", "LangChain", "fal", "Framer"]);
    const latest = (id: string) => w.rt.ledger.latestAttempt(id)!;
    const [modal, pi, replicate, langchain, fal, framer] = cases.map((c) => c.id) as [string, string, string, string, string, string];
    expect([latest(modal).state, latest(modal).failureCode]).toEqual(["DEAD", "91402"]);
    expect([latest(pi).state, latest(pi).awxStatus]).toEqual(["LIVE", "SENT"]);
    expect(latest(replicate).state).toBe("DEAD");
    expect([latest(langchain).state, latest(langchain).failureCode]).toEqual(["DEAD", "91301"]);
    expect(latest(fal).state).toBe("PAID");
    expect(latest(framer).state).toBe("PAID");
    // Every invoice was approved by a person and paid once; nothing an agent did is on the record yet.
    for (const c of cases) {
      expect(w.types(c.id)).toContain("REQUEST_APPROVED");
      expect(w.types(c.id)).toContain("CASE_OPENED");
      expect(w.types(c.id)).not.toContain("AGENT_TOOL_CALL");
      expect(w.rt.ledger.attemptsFor(c.id)).toHaveLength(1);
    }
    const lanes = await w.board();
    expect(lanes.filter((l) => l.case).map((l) => l.case!.outcome.state)).toEqual(Array(6).fill("open"));
    expect(lanes.find((l) => l.id === modal)!.case!.problem.headline).toBe("Bounced, and Modal is past due");
    expect(w.rt.ledger.verifyChain().ok).toBe(true);
  });

  it("gives every case new invoice numbers when the morning is loaded again", async () => {
    const w = world();
    const first = (await w.morning()).map((c) => c.reference);
    const second = (await w.morning()).map((c) => c.reference);
    expect(new Set([...first, ...second]).size).toBe(12);
  });

  it("is refused where there is no simulator: production money is never staged", async () => {
    const w = world();
    const handle = createApi({
      ledger: w.rt.ledger, gateway: w.rt.gateway, commander: w.rt.commander, closer: w.rt.closer, model: null, simulator: null,
      token: TOKEN, operator: OPERATOR, beneficiaryId: "x", paidHoldMs: 0,
    });
    const response = await handle(new Request("http://api.test/api/supplier-issues", { method: "POST", headers: { "x-tessera-token": TOKEN } }));
    expect(response.status).toBe(403);
  });
});

describe("Visa TAP: the agent pays the supplier only once a person has authorized the card", () => {
  it("asks for the card, cannot sign it, cannot pay while it waits, and pays through TAP after a person signs", async () => {
    const w = world();
    const [modal] = await w.morning();
    const id = modal!.id;
    const { toolbox, run } = w.agent([id]);

    await run();
    expect(w.card(id)?.state).toBe("PENDING");
    expect((await w.lane(id)).case!.outcome).toMatchObject({ state: "yours", headline: "Authorize the Visa card" });

    // The agent cannot authorize its own card, by any route.
    await expect(w.rt.cards.approve(w.card(id)!.id, "agent:scripted", "I authorize this card myself, honestly.")).rejects.toThrow(/agent cannot sign/);
    // Asked to pay while the card waits for a person, policy refuses; another full pass only waits.
    const early = await toolbox.call("pay_invoice_by_card", { incidentId: id, reason: "Pay before anyone has signed it." });
    expect(early).toMatchObject({ ok: false, kind: "refused" });
    await run();
    expect(w.types(id)).not.toContain("CARD_CHECKOUT");
    expect(w.card(id)?.state).toBe("PENDING");

    // A person authorizes it in writing; Airwallex issues it; now the agent pays the checkout through Visa TAP.
    const signed = await w.call("POST", `/api/cards/${w.card(id)!.id}/approve`, { note: "Modal is waiting on this invoice; pay it once by card." });
    expect(signed.data.state).toBe("ACTIVE");
    expect((await w.lane(id)).case!.outcome.headline).toBe("Authorized; the agent pays");
    await run();

    const checkout = w.rt.ledger.events(id).find((e) => e.type === "CARD_CHECKOUT")!.payload as { status: string; actor: string; tap: { verified: boolean } };
    expect(checkout).toMatchObject({ status: "APPROVED", actor: "agent:scripted", tap: { verified: true } });
    // The authorization comes before the payment on the record, and the payment is the only one: no second transfer.
    const order = w.types(id);
    expect(order.indexOf("CARD_DECIDED")).toBeLessThan(order.indexOf("CARD_CHECKOUT"));
    expect(w.rt.ledger.attemptsFor(id).map((a) => a.state)).toEqual(["DEAD"]);

    await w.rt.cards.sync();
    const done = (await w.lane(id)).case!;
    expect(done.outcome).toMatchObject({ state: "solved", headline: "Paid once by Visa, via TAP" });
    expect(done.steps.map((s) => s.label)).toEqual(
      expect.arrayContaining(["Read email", "Asked for card", "Authorized", "Card issued", "Paid via TAP", "Cleared"]),
    );
    const labels = done.steps.map((s) => s.label);
    expect(labels.indexOf("Authorized")).toBeLessThan(labels.indexOf("Paid via TAP"));
    expect(done.steps.find((s) => s.label === "Authorized")!.actor).toBe("you");

    // Certified with the card, once it has cleared and held.
    await run();
    expect((await w.lane(id)).case!.outcome.state).toBe("certified");
  });

  it("a declined card is never paid with, and the invoice may be paid another way", async () => {
    const w = world();
    const [modal] = await w.morning();
    const id = modal!.id;
    await w.agent([id]).run();
    expect((await w.call("POST", `/api/cards/${w.card(id)!.id}/decline`, { note: "Modal prefers a bank transfer this time." })).status).toBe(200);
    expect(w.card(id)).toBeNull();
    expect(w.types(id)).not.toContain("CARD_CHECKOUT");
  });
});

describe("the agent works the morning, and each case lands where policy says", () => {
  it("fixes what it may alone, holds what could pay twice, stops the impostor, and hands the rest to a person", async () => {
    const w = world();
    const cases = await w.morning();
    const [modal, pi, replicate, langchain, fal, framer] = cases.map((c) => c.id) as [string, string, string, string, string, string];
    await w.agent(cases.map((c) => c.id)).run();

    const state = async (id: string) => (await w.lane(id)).case!.outcome;
    expect(await state(modal)).toMatchObject({ state: "yours", headline: "Authorize the Visa card" });
    expect(await state(pi)).toMatchObject({ state: "yours", headline: "Held; reply ready" });
    expect(await state(replicate)).toMatchObject({ state: "working", headline: "Replacement on its way" });
    expect(await state(langchain)).toMatchObject({ state: "yours", headline: "Confirm with LangChain" });
    expect(await state(fal)).toMatchObject({ state: "yours", headline: "Proof ready to send" });
    expect(await state(framer)).toMatchObject({ state: "solved", headline: "Fraud stopped" });
    // Nothing paid twice, nothing paid to the impostor's account.
    expect(w.rt.ledger.attemptsFor(pi)).toHaveLength(1);
    expect(w.rt.ledger.attemptsFor(framer)).toHaveLength(1);
    expect(w.rt.ledger.attemptsFor(langchain)).toHaveLength(1);

    // The bank pays the replacement on its clock: solved without a person.
    await w.tick(20_000);
    expect(await state(replicate)).toMatchObject({ state: "solved", headline: "Paid once, by the replacement" });

    // A person sends the drafted proof: answered, and the agent does not draft it again.
    const draft = (id: string) => w.call("GET", `/api/obligations/${id}`).then((r) => r.data.draft as { seq: number });
    await w.call("POST", `/api/obligations/${fal}/drafts/resolve`, { draftSeq: (await draft(fal)).seq, resolution: "SENT" });
    expect(await state(fal)).toMatchObject({ state: "solved", headline: "Proof of payment sent" });
    await w.agent([fal]).run();
    expect(w.types(fal).filter((t) => t === "DRAFT_REPLY")).toHaveLength(1);
    expect(await state(fal)).toMatchObject({ state: "solved" });

    // The held transfer lands once the call to hold it is 30s old: holding was right.
    expect(w.rt.ledger.latestAttempt(pi)!.state).toBe("LIVE");
    await w.tick(31_000);
    expect(w.rt.ledger.latestAttempt(pi)!.state).toBe("PAID");
    expect(await state(pi)).toMatchObject({ state: "solved", headline: "Paid once" });
    expect(w.rt.ledger.verifyChain().ok).toBe(true);
  });

  it("records what the agent was told when it looked, so its reasoning is on the ledger", async () => {
    const w = world();
    const [modal] = await w.morning();
    await w.agent([modal!.id]).run();
    const assessed = w.rt.ledger.events(modal!.id).find((e) => e.type === "AGENT_TOOL_CALL" && (e.payload as { tool: string }).tool === "assess_incident")!;
    expect(assessed.payload).toMatchObject({ verdict: { recommended: "PAY_BY_CARD", reasons: expect.arrayContaining([expect.stringContaining("Visa card")]) } });
  });

  it("shows a guardrail test only where it was stopped, folded into one step", async () => {
    const w = world();
    const [, pi] = await w.morning();
    const { toolbox } = w.agent([pi!.id], "agent:adversary");
    for (let i = 0; i < 3; i++) await toolbox.call("replace_payment", { incidentId: pi!.id });
    await toolbox.call("reconcile_and_close", { incidentId: pi!.id });
    const steps = (await w.lane(pi!.id)).case!.steps;
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ actor: "test", kind: "refused", count: 4 });
    expect(steps[0]!.text).toMatch(/^Guardrail test\. Tried 4 moves policy forbids: pay it again, certify it early\. Every one refused\.$/);
    expect(w.rt.ledger.attemptsFor(pi!.id)).toHaveLength(1);
  });
});

describe("the bank clock ends a case's delay only after the call to hold it", () => {
  it("leaves a delayed transfer alone until someone has held it, then lands it once and says so", async () => {
    const w = world();
    const [, pi] = await w.morning();
    const id = pi!.id;
    await w.at(10 * 60_000);
    expect(w.rt.ledger.latestAttempt(id)!.awxStatus).toBe("SENT");
    await w.agent([id]).run();
    await w.at(28_000);
    expect(w.rt.ledger.latestAttempt(id)!.awxStatus).toBe("SENT");
    await w.at(31_000);
    expect(w.rt.ledger.latestAttempt(id)!.state).toBe("PAID");
    await w.at(90_000);
    expect(w.types(id).filter((t) => t === "STORY_STEP")).toHaveLength(1);
  });

  it("never lands a transfer whose case does not say it lands", async () => {
    const w = world();
    const cases = await w.morning();
    await w.agent(cases.map((c) => c.id)).run();
    await w.tick(10 * 60_000);
    for (const c of cases.filter((_, i) => MORNING[i]!.lands !== true)) expect(w.types(c.id)).not.toContain("STORY_STEP");
  });
});

describe("a reply already sent is not offered again until the supplier writes back", () => {
  const facts = (repliesSent: IncidentFacts["repliesSent"], attempt: { state: "PAID" | "LIVE" }): IncidentFacts => ({
    obligation: { id: "o", amountMinor: 1000, currency: "USD", status: attempt.state === "PAID" ? "PAID" : "PAYING", escalationReason: null },
    attempts: [{ id: "a", obligationId: "o", seq: 1, state: attempt.state, awxStatus: attempt.state === "PAID" ? "PAID" : "SENT", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), method: "LOCAL" } as never],
    paidObservedAt: attempt.state === "PAID" ? new Date().toISOString() : null, failedObservedAt: null, automaticReplacements: 0, wallets: { USD: 10_000_000 }, fxRates: {}, funding: null,
    evidence: { claimsNonReceipt: true, requestsDetailChange: false, referencesObligation: true, statementCredit: null, containsEmbeddedInstructions: false, summary: "", adjustments: [] },
    repliesSent, now: new Date(),
  });

  it("proof sent: wait for the supplier's bank, never pay again, never draft it twice", () => {
    expect(decide(facts({}, { state: "PAID" }), DEFAULT_POLICY).recommended).toBe("SEND_PROOF_TO_SUPPLIER");
    const after = decide(facts({ PROOF: true }, { state: "PAID" }), DEFAULT_POLICY);
    expect(after.recommended).toBe("WAIT");
    expect(after.allowed).not.toContain("SEND_PROOF_TO_SUPPLIER");
    expect(after.allowed).not.toContain("REPLACE");
  });

  it("status sent: keep waiting, without offering the same status again", () => {
    expect(decide(facts({}, { state: "LIVE" }), DEFAULT_POLICY).allowed).toContain("SEND_STATUS_TO_SUPPLIER");
    expect(decide(facts({ STATUS: true }, { state: "LIVE" }), DEFAULT_POLICY).allowed).not.toContain("SEND_STATUS_TO_SUPPLIER");
  });
});
