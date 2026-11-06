/**
 * A fake-Airwallex world wired the way the API process wires webhooks: route -> handler -> gateway re-read -> reactor
 * -> (optionally) the wake scheduler. Shared by tests/webhook.test.ts and the red team.
 */
import type { AgentModel } from "../../src/agent/loop";
import { signedDelivery, transferEventBody } from "../../src/airwallex/fake-webhooks";
import type { Transfer } from "../../src/airwallex/types";
import { Closer } from "../../src/closer/closer";
import type { Block, ConverseRequest, ConverseResult } from "../../src/commander/anthropic";
import { Commander } from "../../src/commander/commander";
import { DEFAULT_POLICY } from "../../src/commander/policy";
import { AgentWakeSchema, IncidentReactionSchema, WebhookReceivedSchema } from "../../src/ledger/events";
import type { LedgerEvent } from "../../src/ledger/ledger";
import { AgentGate } from "../../src/server/agent-runs";
import { Reactor } from "../../src/server/reactions";
import { WakeScheduler, type WakeLimits } from "../../src/server/wake";
import { createWebhookHandler } from "../../src/server/webhook";
import { publicWebhookRoutes, WEBHOOK_PATH } from "../../src/server/webhook-listener";
import { approve, SECRET, world } from "./world";

export const WH = "whsec_test_endpoint_secret";
export const URL_ = `http://listener.test${WEBHOOK_PATH}`;

export const ofType = (events: LedgerEvent[], type: string) => events.filter((e) => e.type === type);
export const reactions = (events: LedgerEvent[]) => ofType(events, "INCIDENT_REACTION").map((e) => IncidentReactionSchema.parse(e.payload));
export const wakes = (events: LedgerEvent[]) => ofType(events, "AGENT_WAKE").map((e) => AgentWakeSchema.parse(e.payload));
export const receipts = (events: LedgerEvent[]) => ofType(events, "WEBHOOK_RECEIVED").map((e) => WebhookReceivedSchema.parse(e.payload));

/** An agent that records each task it is given and, when told to, lists its incidents before answering. */
export function recordingAgent(options: { list?: boolean; hold?: Promise<void> } = {}) {
  const tasks: string[] = [];
  const started = Promise.withResolvers<void>();
  const listed: unknown[] = [];
  let live = 0;
  let peak = 0;
  const model: AgentModel = {
    async converse(request: ConverseRequest): Promise<ConverseResult> {
      const first = request.messages[0]!;
      if (request.messages.length === 1) {
        tasks.push(String(first.content));
        started.resolve();
        live++;
        peak = Math.max(peak, live);
        await options.hold;
        if (options.list) {
          const content: Block[] = [{ type: "tool_use", id: "t1", name: "list_incidents", input: {} }];
          return { content, stopReason: "tool_use" };
        }
      } else {
        const last = request.messages.at(-1)!;
        if (Array.isArray(last.content)) for (const b of last.content) if (b.type === "tool_result") listed.push(JSON.parse(b.content));
      }
      live--;
      return { content: [{ type: "text", text: "INV: looked, because woken" }], stopReason: "end_turn" };
    },
  };
  return { model, tasks, listed, peak: () => peak, started: started.promise };
}

export function webhookRig(options: { agent?: AgentModel | null; limits?: Partial<WakeLimits>; gate?: AgentGate; sources?: ReadonlySet<string> } = {}) {
  const w = world();
  const commander = new Commander({ ledger: w.ledger, gateway: w.gateway, balances: w.api, secret: SECRET, policy: { ...DEFAULT_POLICY, paidHoldMs: 0 } });
  const closer = new Closer({ ledger: w.ledger, api: w.api, gateway: w.gateway, secret: SECRET, paidHoldMs: 0 });
  const gate = options.gate ?? new AgentGate();
  const scheduler = options.agent
    ? new WakeScheduler({
        ledger: w.ledger, gateway: w.gateway, commander, closer, model: null, gate,
        agent: { model: options.agent, actor: "agent:test", kind: "scripted" },
        limits: { debounceMs: 30, maxGateWaitMs: 2_000, ...options.limits },
      })
    : null;
  const reactor = new Reactor({ ledger: w.ledger, commander, wake: scheduler ? (id, cause) => scheduler.request(id, cause) : null });
  const handler = createWebhookHandler({ ledger: w.ledger, gateway: w.gateway, secret: WH, reactor });
  const route = publicWebhookRoutes(handler, options.sources ? { allowedSources: options.sources } : {});

  const transfer = (): Transfer => structuredClone(w.api.all[0]!);
  /** Delivers the transfer's current state as Airwallex would, or a body of the caller's. */
  const deliver = async (body?: string, headers: Record<string, string> = {}, signing: { secret?: string; timestamp?: string } = {}) => {
    const request = signedDelivery(URL_, signing.secret ?? WH, body ?? transferEventBody(transfer(), { accountId: "acct_test" }), signing.timestamp);
    for (const [k, v] of Object.entries(headers)) request.headers.set(k, v);
    const response = await route(request);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const pay = async () => {
    const { attempt } = await w.gateway.submit(approve(w.obligation));
    return attempt.transferId!;
  };
  return { ...w, commander, closer, gate, scheduler, reactor, route, deliver, transfer, pay };
}
