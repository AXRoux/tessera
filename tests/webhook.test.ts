import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { OfflineWebhooks, signedDelivery, transferEventBody } from "../src/airwallex/fake-webhooks";
import { AwxNetworkError } from "../src/airwallex/types";
import { ScriptedAgentModel } from "../src/demo/scripted-agent";
import { AgentGate } from "../src/server/agent-runs";
import { buildRuntime, offlineSimulator } from "../src/server/runtime";
import { createWebhookHandler } from "../src/server/webhook";
import { AIRWALLEX_SANDBOX_IPS, publicWebhookRoutes, startWebhookListener, WEBHOOK_PATH } from "../src/server/webhook-listener";
import { approve } from "./helpers/world";
import { ofType, reactions, receipts, recordingAgent, URL_, wakes, webhookRig as rig, WH } from "./helpers/webhook-rig";
import type { AgentModel } from "../src/agent/loop";
import type { ConverseRequest, ConverseResult } from "../src/commander/anthropic";
import { AgentWakeFinishedSchema } from "../src/ledger/events";

describe("webhook route: verify, dedupe, re-read", () => {
  it("re-reads the transfer on the first delivery and ignores a redelivery", async () => {
    const r = rig();
    const transferId = await r.pay();
    r.api.advance(transferId, "PAID");
    const body = transferEventBody(r.transfer(), { accountId: "acct_test", id: "evt_2" });

    const first = await r.deliver(body);
    expect(first.status).toBe(200);
    expect(first.body.duplicate).toBe(false);
    expect(r.ledger.latestAttempt(r.obligation.id)!.state).toBe("PAID");
    const after = r.ledger.events().length;

    const again = await r.deliver(body);
    expect(again.body.duplicate).toBe(true);
    expect(r.ledger.events()).toHaveLength(after);
  });

  it("refuses a forged signature, and a delivery that brings its own signing key (a web-app test event)", async () => {
    const r = rig();
    await r.pay();
    const body = transferEventBody(r.transfer(), { accountId: "acct_test" });
    const ts = String(Date.now());
    const own = signedDelivery(URL_, "the-key-in-my-header", body, ts);
    own.headers.set("client-secret-key", "the-key-in-my-header");

    const route = publicWebhookRoutes(createWebhookHandler({ ledger: r.ledger, gateway: r.gateway, secret: WH, reactor: null }));
    expect((await route(own)).status).toBe(401);
    expect(receipts(r.ledger.events())).toHaveLength(0);
  });

  it("14. refuses on content-length alone, without reading the body", async () => {
    const r = rig();
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({ pull() { pulled = true; } }, { highWaterMark: 0 });
    const request = new Request(URL_, {
      method: "POST", body, duplex: "half", headers: { "content-length": String(50 * 1024 * 1024), "x-timestamp": String(Date.now()), "x-signature": "00" },
    } as RequestInit);

    expect((await createWebhookHandler({ ledger: r.ledger, gateway: r.gateway, secret: WH, reactor: null })(request)).status).toBe(413);
    expect(pulled).toBe(false);
  });

  it("14. refuses a body over the cap even with no content-length to trust", async () => {
    const r = rig();
    expect((await r.deliver("x".repeat(200 * 1024))).status).toBe(413);
  });

  it("15. a failed sync is not swallowed by the dedupe: the event stays retryable and is handled on redelivery", async () => {
    const r = rig();
    const transferId = await r.pay();
    r.api.advance(transferId, "PAID");
    const body = transferEventBody(r.transfer(), { accountId: "acct_test", id: "evt_retry" });
    const working = r.api.getTransfer.bind(r.api);
    r.api.getTransfer = async () => {
      throw new AwxNetworkError("connection reset");
    };

    expect((await r.deliver(body)).status).toBe(503);
    expect(r.ledger.webhookEventSeen("evt_retry")).toBe(false);
    expect(r.ledger.latestAttempt(r.obligation.id)!.state).toBe("LIVE");

    r.api.getTransfer = working;
    const redelivered = await r.deliver(body);
    expect(redelivered.body.duplicate).toBe(false);
    expect(r.ledger.latestAttempt(r.obligation.id)!.state).toBe("PAID");
    expect((await r.deliver(body)).body.duplicate).toBe(true);
  });

  it("never moves state backwards: an older event delivered after a newer one is re-read, marked out of order, and changes nothing", async () => {
    const r = rig();
    const transferId = await r.pay();
    r.api.advance(transferId, "SENT");
    const sentBody = transferEventBody(r.transfer(), { accountId: "acct_test", now: new Date(Date.now() - 60_000) });
    r.api.advance(transferId, "PAID");

    expect((await r.deliver()).body.outcome).toBe("applied");
    const late = await r.deliver(sentBody);

    expect(late.body.outcome).toBe("out_of_order");
    expect(r.ledger.latestAttempt(r.obligation.id)!.awxStatus).toBe("PAID");
    expect(r.ledger.verifyChain().ok).toBe(true);
  });

  it("never moves state backwards: a re-read that returns an older snapshot than the ledger holds is dropped", async () => {
    const r = rig();
    const transferId = await r.pay();
    r.api.advance(transferId, "SENT");
    const older = r.transfer();
    r.api.advance(transferId, "PAID");
    await r.deliver();
    // Airwallex answers the next read from a lagging replica: SENT, stamped before the PAID already applied.
    r.api.getTransfer = async () => structuredClone(older);

    await r.deliver(transferEventBody(older, { accountId: "acct_test" }));

    expect(r.ledger.latestAttempt(r.obligation.id)!.awxStatus).toBe("PAID");
  });

  it("a webhook that claims PAID while Airwallex says SENT changes nothing but the record of what it claimed", async () => {
    const r = rig();
    const transferId = await r.pay();
    r.api.advance(transferId, "SENT");
    await r.deliver();
    const lie = transferEventBody({ ...r.transfer(), status: "PAID" }, { accountId: "acct_test" });

    const answer = await r.deliver(lie);

    expect(answer.body.outcome).toBe("no_change");
    expect(r.ledger.latestAttempt(r.obligation.id)!.awxStatus).toBe("SENT");
    expect(receipts(r.ledger.events()).at(-1)).toMatchObject({ claimedStatus: "PAID", outcome: "no_change" });
    expect(reactions(r.ledger.events()).every((x) => x.changes.every((c) => c.to !== "PAID"))).toBe(true);
  });

  it("an event for a transfer Tessera never created (another account's, or invented) is recorded and changes nothing", async () => {
    const r = rig();
    await r.pay();
    const stranger = { ...r.transfer(), id: randomUUID(), request_id: randomUUID(), status: "PAID" };

    const answer = await r.deliver(transferEventBody(stranger, { accountId: "acct_someone_else" }));

    expect(answer.body.outcome).toBe("unknown_transfer");
    expect(reactions(r.ledger.events())).toHaveLength(0);
    expect(r.ledger.latestAttempt(r.obligation.id)!.awxStatus).toBe("PROCESSING");
  });

  it("chains every taken delivery: deleting a dedupe row (to replay it) or inserting one (to drop a real one) breaks verification", async () => {
    const r = rig();
    const transferId = await r.pay();
    r.api.advance(transferId, "PAID");
    await r.deliver(transferEventBody(r.transfer(), { accountId: "acct_test", id: "evt_kept" }));
    expect(r.ledger.verifyChain().ok).toBe(true);

    r.ledger.db.query("DELETE FROM webhook_events WHERE id = 'evt_kept'").run();
    expect(r.ledger.verifyChain()).toMatchObject({ ok: false, reason: expect.stringContaining("evt_kept") });

    const s = rig();
    await s.pay();
    await s.deliver();
    s.ledger.db.query("INSERT INTO webhook_events (id, name, transferId, createdAt, receivedAt) VALUES ('evt_future', 'payout.transfer.paid', NULL, ?, ?)")
      .run(new Date().toISOString(), new Date(Date.now() + 1000).toISOString());
    expect(s.ledger.verifyChain()).toMatchObject({ ok: false, reason: expect.stringContaining("evt_future") });
  });
});

describe("reactions: reassess after a bank-side change", () => {
  it("FAILED then CANCELLED: the reaction credits the webhook by event id and records the decision before and after", async () => {
    const r = rig({ agent: recordingAgent().model });
    const transferId = await r.pay();
    r.api.advance(transferId, "SENT");
    await r.deliver();
    r.api.advance(transferId, "FAILED", "CHANNEL_TIMEOUT");
    await r.deliver();
    r.api.advance(transferId, "CANCELLED");
    const cancelled = transferEventBody(r.transfer(), { accountId: "acct_test", id: "evt_cancelled" });
    await r.deliver(cancelled);
    await r.scheduler!.idle();

    const last = reactions(r.ledger.events(r.obligation.id)).at(-1)!;
    expect(last.trigger).toMatchObject({ source: "webhook", eventId: "evt_cancelled", eventName: "payout.transfer.cancelled" });
    expect(last.changes.at(-1)).toMatchObject({ from: "FAILED", to: "CANCELLED" });
    expect(last.before.recommended).not.toBe("REPLACE");
    expect(last.after.recommended).toBe("REPLACE");
    expect(last).toMatchObject({ decisionChanged: true, wake: "requested" });
    expect(r.ledger.verifyChain().ok).toBe(true);
  });

  it("the sweep and a webhook behave the same: a change the sweep saw is reacted to once, credited to the sweep", async () => {
    const r = rig();
    const transferId = await r.pay();
    r.api.advance(transferId, "SENT");
    await r.gateway.sync();
    await r.reactor.react({ source: "sweep" });
    await r.deliver();

    const all = reactions(r.ledger.events());
    expect(all).toHaveLength(1);
    expect(all[0]!.trigger.source).toBe("sweep");
    expect(all[0]).toMatchObject({ wake: "off" });
  });

  it("a change a console view synced first is still credited to the webhook that reports it", async () => {
    const r = rig();
    const transferId = await r.pay();
    r.api.advance(transferId, "SENT");
    await r.commander.assess(r.obligation.id);

    const answer = await r.deliver(transferEventBody(r.transfer(), { accountId: "acct_test", id: "evt_late_but_first" }));

    expect(answer.body.outcome).toBe("no_change");
    expect(reactions(r.ledger.events())[0]!.trigger.eventId).toBe("evt_late_but_first");
  });

  it("verifyChain refuses a reaction that cites a transfer change which never happened, or one already covered", async () => {
    const r = rig();
    const transferId = await r.pay();
    r.api.advance(transferId, "SENT");
    await r.deliver();
    const real = reactions(r.ledger.events())[0]!;

    r.ledger.append(r.obligation.id, "INCIDENT_REACTION", real);
    expect(r.ledger.verifyChain()).toMatchObject({ ok: false, reason: expect.stringContaining("reacted to twice") });

    const s = rig();
    await s.pay();
    s.ledger.append(s.obligation.id, "INCIDENT_REACTION", { ...real, changes: [{ ...real.changes[0]!, statusSeq: 999 }] });
    expect(s.ledger.verifyChain()).toMatchObject({ ok: false, reason: expect.stringContaining("999") });
  });

  it("an event storm with no real change at Airwallex writes receipts only: no reaction, no wake", async () => {
    const agent = recordingAgent();
    const r = rig({ agent: agent.model });
    const transferId = await r.pay();
    r.api.advance(transferId, "SENT");
    await r.deliver();
    const before = reactions(r.ledger.events()).length;

    for (let i = 0; i < 50; i++) await r.deliver(transferEventBody({ ...r.transfer(), status: "CANCELLED" }, { accountId: "acct_test" }));
    await r.scheduler!.idle();

    expect(reactions(r.ledger.events())).toHaveLength(before);
    expect(agent.tasks).toHaveLength(0);
  });
});

describe("event-driven agent runs", () => {
  async function failAndCancel(r: ReturnType<typeof rig>, transferId: string, ids: [string, string] = [randomUUID(), randomUUID()]) {
    r.api.advance(transferId, "FAILED", "CHANNEL_TIMEOUT");
    await r.deliver(transferEventBody(r.transfer(), { accountId: "acct_test", id: ids[0] }));
    r.api.advance(transferId, "CANCELLED");
    await r.deliver(transferEventBody(r.transfer(), { accountId: "acct_test", id: ids[1] }));
  }

  it("wakes one run scoped to the incident, naming the Airwallex event that caused it, through the ordinary toolbox", async () => {
    const agent = recordingAgent({ list: true });
    const r = rig({ agent: agent.model });
    const other = r.ledger.createObligation({ reference: "INV-OTHER", beneficiaryId: "ben-A", amountMinor: 500, currency: "USD", method: "LOCAL", reason: "professional_business_services" });
    const transferId = await r.pay();
    r.api.advance(transferId, "SENT");
    await r.deliver();
    await failAndCancel(r, transferId, ["evt_f", "evt_c"]);
    await r.scheduler!.idle();

    expect(agent.tasks).toHaveLength(1);
    expect(agent.tasks[0]).toContain(`Work incident INV-1001 (incidentId ${r.obligation.id}) only`);
    expect(agent.tasks[0]).toContain("payout.transfer.cancelled");
    const listed = JSON.stringify(agent.listed);
    expect(listed).toContain(r.obligation.id);
    expect(listed).not.toContain(other.id);
    const [wake] = wakes(r.ledger.events(r.obligation.id));
    expect(wake).toMatchObject({ outcome: "started", actor: "agent:test", eventIds: ["evt_c"] });
    expect(ofType(r.ledger.events(r.obligation.id), "AGENT_WAKE_FINISHED")).toHaveLength(1);
    expect(r.ledger.verifyChain().ok).toBe(true);
  });

  it("the brief names the incidentId the tools take, so an agent acting on its brief replaces the payment, and the finish records each call", async () => {
    // Like Claude on 2026-11-03: it passes whatever its brief names as the incident; given only the reference, the
    // toolbox answered "outside the scope of this run" and the woken run stopped after one call without replacing.
    const model: AgentModel = {
      async converse(request: ConverseRequest): Promise<ConverseResult> {
        const brief = String(request.messages[0]!.content);
        const incidentId = /incidentId ([0-9a-f-]{36})/.exec(brief)?.[1] ?? /Work incident (\S+)/.exec(brief)![1]!;
        const last = request.messages.at(-1)!;
        const result = Array.isArray(last.content) ? last.content.find((b) => b.type === "tool_result") : undefined;
        const turn = request.messages.length;
        if (turn === 1) return { content: [{ type: "tool_use", id: "a1", name: "assess_incident", input: { incidentId } }], stopReason: "tool_use" };
        if (turn === 3 && result?.type === "tool_result" && result.content.includes('"recommended":"REPLACE"')) {
          return { content: [{ type: "tool_use", id: "r1", name: "replace_payment", input: { incidentId } }], stopReason: "tool_use" };
        }
        return { content: [{ type: "text", text: "INV-1001: acted on the assessment" }], stopReason: "end_turn" };
      },
    };
    const r = rig({ agent: model });
    const transferId = await r.pay();
    await failAndCancel(r, transferId);
    await r.scheduler!.idle();

    expect(r.ledger.attemptsFor(r.obligation.id)).toHaveLength(2);
    const [finished] = ofType(r.ledger.events(r.obligation.id), "AGENT_WAKE_FINISHED").map((e) => AgentWakeFinishedSchema.parse(e.payload));
    expect(finished).toMatchObject({ tools: ["assess_incident:ok", "replace_payment:ok"], report: "INV-1001: acted on the assessment" });
    expect(r.ledger.verifyChain().ok).toBe(true);
  });

  it("debounces a burst: changes on one incident inside the window make one run", async () => {
    const agent = recordingAgent();
    const r = rig({ agent: agent.model, limits: { debounceMs: 200 } });
    const transferId = await r.pay();
    r.api.advance(transferId, "SENT");
    await r.deliver();
    await failAndCancel(r, transferId);
    // Released and resubmitted: one more bank-side change lands inside the same window.
    r.scheduler!.request(r.obligation.id, { reactionSeq: r.ledger.events().findLast((e) => e.type === "INCIDENT_REACTION")!.seq, eventId: "evt_x", eventName: "payout.transfer.cancelled" });
    await r.scheduler!.idle();

    expect(agent.tasks).toHaveLength(1);
    expect(wakes(r.ledger.events())[0]!.reactionSeqs.length).toBeGreaterThanOrEqual(2);
  });

  it("single flight per incident: a request while its run is going becomes one follow-up run, never a parallel one", async () => {
    const { promise: hold, resolve } = Promise.withResolvers<void>();
    const agent = recordingAgent({ hold });
    const r = rig({ agent: agent.model, limits: { debounceMs: 10 } });
    const transferId = await r.pay();
    await failAndCancel(r, transferId);
    await agent.started;
    const seq = r.ledger.events().findLast((e) => e.type === "INCIDENT_REACTION")!.seq;
    for (let i = 0; i < 5; i++) r.scheduler!.request(r.obligation.id, { reactionSeq: seq, eventId: `evt_${i}`, eventName: "payout.transfer.cancelled" });
    resolve();
    await r.scheduler!.idle();

    expect(agent.peak()).toBe(1);
    expect(agent.tasks).toHaveLength(2);
  });

  it("caps runs per incident, counted from the ledger, and records the refusal", async () => {
    const agent = recordingAgent();
    const r = rig({ agent: agent.model, limits: { perIncident: 1, debounceMs: 10 } });
    const transferId = await r.pay();
    await failAndCancel(r, transferId);
    await r.scheduler!.idle();
    const seq = r.ledger.events().findLast((e) => e.type === "INCIDENT_REACTION")!.seq;
    r.scheduler!.request(r.obligation.id, { reactionSeq: seq, eventId: "evt_again", eventName: "payout.transfer.cancelled" });
    await r.scheduler!.idle();

    expect(agent.tasks).toHaveLength(1);
    expect(wakes(r.ledger.events()).map((w) => w.outcome)).toEqual(["started", "capped"]);
    expect(r.ledger.verifyChain().ok).toBe(true);
  });

  it("caps runs across all incidents", async () => {
    const agent = recordingAgent();
    const r = rig({ agent: agent.model, limits: { global: 1, debounceMs: 10 } });
    const transferId = await r.pay();
    await failAndCancel(r, transferId);
    await r.scheduler!.idle();
    const second = r.ledger.createObligation({ reference: "INV-2002", beneficiaryId: "ben-A", amountMinor: 900, currency: "USD", method: "LOCAL", reason: "professional_business_services" });
    const { attempt } = await r.gateway.submit(approve(second));
    r.api.advance(attempt.transferId!, "FAILED", "CHANNEL_TIMEOUT");
    r.api.advance(attempt.transferId!, "CANCELLED");
    await r.deliver(transferEventBody(structuredClone(r.api.transfers.get(attempt.transferId!)!), { accountId: "acct_test" }));
    await r.scheduler!.idle();

    expect(agent.tasks).toHaveLength(1);
    expect(wakes(r.ledger.events(second.id))).toMatchObject([{ outcome: "capped" }]);
  });

  it("shares the one-run-at-a-time gate with console runs: a wake waits, and is skipped if the gate stays busy", async () => {
    const agent = recordingAgent();
    const gate = new AgentGate();
    const r = rig({ agent: agent.model, gate, limits: { debounceMs: 10, maxGateWaitMs: 60 } });
    expect(gate.tryAcquire()).toBe(true); // a console run is streaming
    const transferId = await r.pay();
    await failAndCancel(r, transferId);
    await r.scheduler!.idle();

    expect(agent.tasks).toHaveLength(0);
    expect(wakes(r.ledger.events())).toMatchObject([{ outcome: "skipped" }]);
    gate.release();
  });

  it("is off unless enabled: the reaction says so and nothing runs", async () => {
    const r = rig();
    const transferId = await r.pay();
    r.api.advance(transferId, "FAILED", "CHANNEL_TIMEOUT");
    r.api.advance(transferId, "CANCELLED");
    await r.deliver();

    expect(reactions(r.ledger.events())).toMatchObject([{ wake: "off", after: { recommended: "REPLACE" } }]);
    expect(ofType(r.ledger.events(), "AGENT_WAKE")).toHaveLength(0);
  });
});

describe("offline parity", () => {
  it("the simulated Airwallex delivers signed events to the same route, and the scripted agent is woken and replaces the payment", async () => {
    const r = rig({ agent: new ScriptedAgentModel() });
    const webhooks = new OfflineWebhooks(WH);
    webhooks.bind(publicWebhookRoutes(createWebhookHandler({ ledger: r.ledger, gateway: r.gateway, secret: WH, reactor: r.reactor })));
    const simulator = offlineSimulator(r.api, webhooks);
    const transferId = await r.pay();

    await simulator.advance(transferId, "SENT");
    await simulator.advance(transferId, "FAILED", "CHANNEL_TIMEOUT");
    await r.scheduler!.idle();

    const events = r.ledger.events(r.obligation.id);
    expect(receipts(events).map((x) => x.name)).toEqual(["payout.transfer.sent", "payout.transfer.failed", "payout.transfer.cancelled"]);
    expect(wakes(events)[0]).toMatchObject({ outcome: "started", eventNames: ["payout.transfer.cancelled"] });
    expect(r.ledger.attemptsFor(r.obligation.id)).toHaveLength(2);
    expect(r.ledger.verifyChain().ok).toBe(true);

    // The agent's own replacement is not news from the bank: the next sweep reacts to nothing and wakes no one.
    const before = reactions(r.ledger.events()).length;
    expect(await r.reactor.react({ source: "sweep" })).toHaveLength(0);
    await r.scheduler!.idle();
    expect(reactions(r.ledger.events())).toHaveLength(before);
    expect(wakes(r.ledger.events())).toHaveLength(1);
  });

  it("is off by default and never on in a public demo, whatever the flag says", () => {
    expect(buildRuntime({ TESSERA_OFFLINE: "1" }).agentOnEvent).toBe(false);
    expect(buildRuntime({ TESSERA_OFFLINE: "1", TESSERA_AGENT_ON_EVENT: "1" }).agentOnEvent).toBe(true);
    const pub = buildRuntime({ TESSERA_OFFLINE: "1", TESSERA_PUBLIC_DEMO: "1", TESSERA_AGENT_ON_EVENT: "1" });
    expect(pub.agentOnEvent).toBe(false);
    expect(pub.warnings.join(" ")).toContain("TESSERA_AGENT_ON_EVENT is ignored");
  });

  it("seeding the demo delivers nothing: its history is not news", async () => {
    const r = rig();
    const webhooks = new OfflineWebhooks(WH);
    let delivered = 0;
    webhooks.bind(async () => {
      delivered++;
      return new Response("{}");
    });
    const simulator = offlineSimulator(r.api, webhooks);
    const transferId = await r.pay();

    await simulator.withoutEvents!(() => simulator.advance(transferId, "PAID"));
    expect(delivered).toBe(0);
    await simulator.advance(transferId, "FAILED", "CHANNEL_TIMEOUT");
    expect(delivered).toBe(2);
  });
});

describe("the public listener", () => {
  it("serves exactly one route: every operator route, other method and path trick is refused before any handler runs", async () => {
    let reached = 0;
    const server = startWebhookListener({ port: 0, handle: async () => { reached++; return new Response("{}"); } });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const probes: Array<[string, string, number]> = [
        ["GET", "/api/health", 404],
        ["GET", "/api/obligations", 404],
        ["POST", "/api/obligations", 404],
        ["POST", "/api/agent/run", 404],
        ["POST", "/api/demo/reset", 404],
        ["GET", WEBHOOK_PATH, 405],
        ["PUT", WEBHOOK_PATH, 405],
        ["POST", `${WEBHOOK_PATH}/`, 404],
        ["POST", "/api/webhooks/airwallex/%2e%2e/%2e%2e/obligations", 404],
        ["POST", "/API/WEBHOOKS/AIRWALLEX", 404],
      ];
      for (const [method, path, status] of probes) {
        const response = await fetch(`${base}${path}`, { method, headers: { "x-tessera-token": "anything" } });
        expect([method, path, response.status]).toEqual([method, path, status]);
      }
      expect(reached).toBe(0);
      expect((await fetch(`${base}${WEBHOOK_PATH}`, { method: "POST", body: "{}" })).status).toBe(200);
      expect(reached).toBe(1);
      expect((await fetch(`${base}${WEBHOOK_PATH}`, { method: "POST", body: "x".repeat(1024 * 1024) })).status).toBe(413);
      expect(reached).toBe(1);
    } finally {
      await server.stop(true);
    }
  });

  it("with a source allowlist, sheds anything Cloudflare did not see coming from a listed address", async () => {
    const r = rig({ sources: new Set(AIRWALLEX_SANDBOX_IPS) });
    await r.pay();

    expect((await r.deliver(undefined, { "cf-connecting-ip": "203.0.113.9" })).status).toBe(403);
    expect((await r.deliver()).status).toBe(403);
    expect((await r.deliver(undefined, { "cf-connecting-ip": "34.142.189.194" })).status).toBe(200);
  });
});
