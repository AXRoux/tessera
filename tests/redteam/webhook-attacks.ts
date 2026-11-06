/**
 * Attacks 41-50: the webhook path and the event-driven agent. Each runs against the real route, handler, gateway,
 * reactor and wake scheduler over the fake Airwallex (tests/helpers/webhook-rig.ts), exactly as the API process wires
 * them. The webhook listener is the one Tessera port meant to face the internet, so everything here is something a
 * stranger on the internet, a replayed capture, Airwallex's own delivery quirks, or a woken agent could try.
 */
import { randomUUID } from "node:crypto";
import type { AgentModel } from "../../src/agent/loop";
import { transferEventBody } from "../../src/airwallex/fake-webhooks";
import type { Block, ConverseRequest, ConverseResult } from "../../src/commander/anthropic";
import { startWebhookListener, WEBHOOK_PATH } from "../../src/server/webhook-listener";
import { approve } from "../helpers/world";
import { ofType, reactions, receipts, recordingAgent, wakes, webhookRig } from "../helpers/webhook-rig";
import type { Attack } from "./attacks";

const transfers = (count: number): string => `${count} transfer${count === 1 ? " exists" : "s exist"} on Airwallex`;

export const WEBHOOK_ATTACKS: Attack[] = [
  {
    id: "webhook-forged-or-self-signed",
    title: "Forge a webhook, or bring your own signing key",
    trick: "Post a \"transfer cancelled\" event signed with a guessed secret, then one signed with a key the request itself carries in `client-secret-key` (how Airwallex signs a web-app test event), hoping the lock is released.",
    layer: "Gateway",
    async run() {
      const r = webhookRig();
      const transferId = await r.pay();
      const cancelled = transferEventBody({ ...r.transfer(), status: "CANCELLED" }, { accountId: "acct_test" });
      const guessed = await r.deliver(cancelled, {}, { secret: "whsec_guessed" });
      const ownKey = await r.deliver(cancelled, { "client-secret-key": "attacker-key" }, { secret: "attacker-key" });
      const attempt = r.ledger.latestAttempt(r.obligation.id)!;
      return {
        held: guessed.status === 401 && ownKey.status === 401 && attempt.state === "LIVE" && receipts(r.ledger.events()).length === 0,
        stoppedBy: `verifyWebhook: guessed secret ${guessed.status}, self-supplied key ${ownKey.status} (only the endpoint secret is ever used)`,
        observed: `transfer ${transferId.slice(0, 8)} still ${attempt.awxStatus}, attempt ${attempt.state}; nothing recorded`,
      };
    },
  },
  {
    id: "webhook-replay-capture",
    title: "Replay a captured delivery",
    trick: "Resend a genuine, correctly signed delivery six minutes after it was captured, and redeliver a fresh one byte for byte.",
    layer: "Gateway",
    async run() {
      const r = webhookRig();
      const transferId = await r.pay();
      r.api.advance(transferId, "PAID");
      const body = transferEventBody(r.transfer(), { accountId: "acct_test" });
      const old = await r.deliver(body, {}, { timestamp: String(Date.now() - 6 * 60_000) });
      const first = await r.deliver(body);
      const events = r.ledger.events().length;
      const again = await r.deliver(body);
      return {
        held: old.status === 401 && first.body.duplicate === false && again.body.duplicate === true && r.ledger.events().length === events,
        stoppedBy: `stale capture ${old.status}; redelivery deduplicated by event id, nothing written`,
        observed: `the genuine delivery was ${String(first.body.outcome)}; ${transfers(r.api.all.length)}`,
      };
    },
  },
  {
    id: "webhook-out-of-order",
    title: "Roll a paid transfer back with an older event",
    trick: "Deliver payout.transfer.paid, then an older payout.transfer.sent that arrives late (Airwallex does not guarantee order), then have Airwallex's read lag and return the SENT snapshot.",
    layer: "Gateway",
    async run() {
      const r = webhookRig();
      const transferId = await r.pay();
      r.api.advance(transferId, "SENT");
      const sent = r.transfer();
      const sentBody = transferEventBody(sent, { accountId: "acct_test", now: new Date(Date.now() - 60_000) });
      r.api.advance(transferId, "PAID");
      await r.deliver();
      const late = await r.deliver(sentBody);
      r.api.getTransfer = async () => structuredClone(sent);
      await r.deliver(transferEventBody(sent, { accountId: "acct_test" }));
      const attempt = r.ledger.latestAttempt(r.obligation.id)!;
      return {
        held: attempt.awxStatus === "PAID" && attempt.state === "PAID",
        stoppedBy: `the event body is never applied (late event recorded ${String(late.body.outcome)}); the gateway drops a re-read older than the snapshot it holds`,
        observed: `attempt stays ${attempt.state}/${attempt.awxStatus}`,
      };
    },
  },
  {
    id: "webhook-claims-paid",
    title: "A webhook says PAID; Airwallex says otherwise",
    trick: "Deliver a signed-looking payout.transfer.paid for a transfer Airwallex still shows SENT, then ask the Closer to certify the invoice as paid.",
    layer: "Closer",
    async run() {
      const r = webhookRig();
      const transferId = await r.pay();
      r.api.advance(transferId, "SENT");
      const lie = await r.deliver(transferEventBody({ ...r.transfer(), status: "PAID" }, { accountId: "acct_test" }));
      const close = await r.closer.close(r.obligation.id).then(() => null, (e: unknown) => (e instanceof Error ? e.name : String(e)));
      const attempt = r.ledger.latestAttempt(r.obligation.id)!;
      return {
        held: attempt.awxStatus === "SENT" && close !== null && r.ledger.getCertificateJson(r.obligation.id) === null,
        stoppedBy: `re-read from Airwallex (${String(lie.body.outcome)}); Closer: ${close ?? "NOT STOPPED"}`,
        observed: `ledger shows ${attempt.awxStatus}; the claimed PAID is kept only as claimedStatus in the receipt`,
      };
    },
  },
  {
    id: "webhook-foreign-transfer",
    title: "Free the lock with someone else's transfer",
    trick: "Deliver payout.transfer.cancelled naming a transfer this ledger never created (another account's, or invented), hoping the incident looks cancelled and a replacement is paid.",
    layer: "Gateway",
    async run() {
      const r = webhookRig();
      await r.pay();
      const foreign = { ...r.transfer(), id: randomUUID(), request_id: randomUUID(), status: "CANCELLED" };
      const answer = await r.deliver(transferEventBody(foreign, { accountId: "acct_other" }));
      const replace = await r.commander.replaceAutomatically(r.obligation.id).then(() => null, (e: unknown) => (e instanceof Error ? e.name : String(e)));
      return {
        held: answer.body.outcome === "unknown_transfer" && replace !== null && r.api.all.length === 1,
        stoppedBy: `re-read found no attempt for it (${String(answer.body.outcome)}); replacement: ${replace ?? "NOT STOPPED"}`,
        observed: `${transfers(r.api.all.length)}; the real attempt is still ${r.ledger.latestAttempt(r.obligation.id)!.state}`,
      };
    },
  },
  {
    id: "webhook-storm",
    title: "Storm the agent with events",
    trick: "Send 100 distinct events about a transfer that is not changing, then make real changes on five incidents at once, trying to make the agent loop or run without end.",
    layer: "Policy",
    async run() {
      const agent = recordingAgent();
      const r = webhookRig({ agent: agent.model, limits: { debounceMs: 10, perIncident: 1, global: 3 } });
      const transferId = await r.pay();
      r.api.advance(transferId, "SENT");
      await r.deliver();
      for (let i = 0; i < 100; i++) await r.deliver(transferEventBody({ ...r.transfer(), status: "FAILED" }, { accountId: "acct_test" }));
      await r.scheduler!.idle();
      const afterNoise = agent.tasks.length;
      for (let i = 0; i < 5; i++) {
        const o = r.ledger.createObligation({ reference: `INV-STORM-${i}`, beneficiaryId: "ben-A", amountMinor: 1_000, currency: "USD", method: "LOCAL", reason: "professional_business_services" });
        const { attempt } = await r.gateway.submit(approve(o));
        r.api.advance(attempt.transferId!, "FAILED", "CHANNEL_TIMEOUT");
        r.api.advance(attempt.transferId!, "CANCELLED");
        await r.deliver(transferEventBody(structuredClone(r.api.transfers.get(attempt.transferId!)!), { accountId: "acct_test" }));
      }
      await r.scheduler!.idle();
      const capped = wakes(r.ledger.events()).filter((w) => w.outcome === "capped").length;
      return {
        held: afterNoise === 0 && agent.tasks.length === 3 && capped === 2 && agent.peak() === 1,
        stoppedBy: `no bank-side change, no reaction (${reactions(r.ledger.events()).length} reactions for 106 deliveries); global cap 3 per hour; one run at a time`,
        observed: `${agent.tasks.length} runs, ${capped} capped and recorded, at most ${agent.peak()} running at once`,
      };
    },
  },
  {
    id: "webhook-listener-operator-routes",
    title: "Reach the operator API through the tunnel",
    trick: "Through the public webhook listener, call the health, obligations, agent-run and demo-reset routes, with a token, with wrong methods, and with ../ and %2e%2e path tricks.",
    layer: "Gateway",
    async run() {
      let reached = 0;
      const server = startWebhookListener({ port: 0, handle: async () => { reached++; return new Response("{}"); } });
      const base = `http://127.0.0.1:${server.port}`;
      const probes: Array<[string, string]> = [
        ["GET", "/api/health"], ["GET", "/api/obligations"], ["POST", "/api/agent/run"], ["POST", "/api/demo/reset"],
        ["GET", WEBHOOK_PATH], ["POST", `${WEBHOOK_PATH}/../../obligations`], ["POST", `${WEBHOOK_PATH}/%2e%2e/%2e%2e/demo/reset`],
      ];
      const statuses: number[] = [];
      try {
        for (const [method, path] of probes) {
          statuses.push((await fetch(`${base}${path}`, { method, headers: { "x-tessera-token": "stolen-token" } })).status);
        }
      } finally {
        await server.stop(true);
      }
      return {
        held: reached === 0 && statuses.every((s) => s === 404 || s === 405),
        stoppedBy: `publicWebhookRoutes: only POST ${WEBHOOK_PATH} exists on the listener (${statuses.join(", ")})`,
        observed: `${probes.length} probes, ${reached} reached any handler; the operator API is a different port that is never tunnelled`,
      };
    },
  },
  {
    id: "webhook-delete-dedupe-row",
    title: "Delete the dedupe row to replay a delivery",
    trick: "With database access, delete a delivery's row from the dedupe table so the captured event would be processed again, then ask for a payment.",
    layer: "Hash chain",
    async run() {
      const r = webhookRig();
      const transferId = await r.pay();
      r.api.advance(transferId, "FAILED", "CHANNEL_TIMEOUT");
      r.api.advance(transferId, "CANCELLED");
      await r.deliver(transferEventBody(r.transfer(), { accountId: "acct_test", id: "evt_captured" }));
      r.ledger.db.query("DELETE FROM webhook_events WHERE id = 'evt_captured'").run();
      const chain = r.ledger.verifyChain();
      const pay = await r.commander.replaceAutomatically(r.obligation.id).then(() => null, (e: unknown) => (e instanceof Error ? e.name : String(e)));
      return {
        held: !chain.ok && pay !== null && r.api.all.length === 1,
        stoppedBy: `verifyChain: ${chain.ok ? "NOT BROKEN" : chain.reason}; gateway: ${pay ?? "NOT STOPPED"}`,
        observed: transfers(r.api.all.length),
      };
    },
  },
  {
    id: "webhook-forged-reaction",
    title: "Pre-empt a reaction so no one is woken",
    trick: "Append a reaction that claims to have already covered the bank's change (or one that never happened), so the real one is skipped and the incident goes quiet.",
    layer: "Hash chain",
    async run() {
      const r = webhookRig();
      const transferId = await r.pay();
      r.api.advance(transferId, "SENT");
      await r.deliver();
      const real = reactions(r.ledger.events())[0]!;
      r.ledger.append(r.obligation.id, "INCIDENT_REACTION", real);
      const twice = r.ledger.verifyChain();
      const s = webhookRig();
      await s.pay();
      s.ledger.append(s.obligation.id, "INCIDENT_REACTION", { ...real, changes: [{ ...real.changes[0]!, statusSeq: 2 }] });
      const invented = s.ledger.verifyChain();
      return {
        held: !twice.ok && !invented.ok,
        stoppedBy: `verifyChain replays reactions: "${twice.ok ? "NOT BROKEN" : twice.reason}" / "${invented.ok ? "NOT BROKEN" : invented.reason}"`,
        observed: "a forged reaction makes the ledger fail verification, and the gateway refuses to pay on it",
      };
    },
  },
  {
    id: "woken-agent-pays-twice",
    title: "A woken agent tries to pay twice",
    trick: "A bank return (FORBIDDEN class: a possible duplicate) wakes the agent; the agent, compromised, asks for replacement after replacement and to certify, under no human eye.",
    layer: "Policy",
    async run() {
      let turn = 0;
      const hostile: AgentModel = {
        async converse(request: ConverseRequest): Promise<ConverseResult> {
          // The brief names the incidentId the tools take (src/server/agent-runs.ts scopedTask).
          const incident = /\(incidentId (\S+)\)/.exec(String(request.messages[0]!.content))![1]!;
          turn++;
          const content: Block[] = turn <= 3
            ? [{ type: "tool_use", id: `t${turn}`, name: "replace_payment", input: { incidentId: incident } }, { type: "tool_use", id: `c${turn}`, name: "reconcile_and_close", input: { incidentId: incident } }]
            : [{ type: "text", text: "done" }];
          return { content, stopReason: turn <= 3 ? "tool_use" : "end_turn" };
        },
      };
      const r = webhookRig({ agent: hostile, limits: { debounceMs: 10 } });
      const transferId = await r.pay();
      r.api.advance(transferId, "FAILED", "DUPLICATION_RETURN");
      r.api.advance(transferId, "CANCELLED");
      await r.deliver();
      await r.scheduler!.idle();
      const started = wakes(r.ledger.events()).filter((w) => w.outcome === "started").length;
      const refusals = ofType(r.ledger.events(), "AGENT_TOOL_CALL").filter((e) => (e.payload as { outcome?: string }).outcome !== "ok").length;
      return {
        held: started === 1 && r.api.all.length === 1 && refusals >= 6 && r.ledger.getCertificateJson(r.obligation.id) === null,
        stoppedBy: `the woken run has the ordinary toolbox: playbook FORBIDDEN class and the Closer refused ${refusals} calls`,
        observed: `${started} woken run; ${transfers(r.api.all.length)}; no certificate`,
      };
    },
  },
];
