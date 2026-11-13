/**
 * Assembles one serving instance from a runtime: startup recovery, the agent gate, event-driven wakes, the reactor,
 * the webhook route and the background sweep, around the HTTP API. The single-operator process (single-main.ts) builds
 * one of these; the multi-tenant host (host.ts) builds one per signed-in workspace from that workspace's own keys.
 */
import { AgentGate } from "./agent-runs";
import { createApi } from "./api";
import { Reactor } from "./reactions";
import type { Instance } from "./resettable";
import { type buildRuntime, resolveBeneficiary } from "./runtime";
import { WakeScheduler } from "./wake";
import { createWebhookHandler } from "./webhook";
import { publicWebhookRoutes } from "./webhook-listener";

export type Runtime = ReturnType<typeof buildRuntime>;

export interface AssembleOptions {
  /** The shared secret the console sends; chosen once by the caller, so a reset keeps the console working. */
  token: string;
  /** Who every human approval in this instance is stamped with. */
  operator: string;
  /** Where the beneficiary is resolved from (TESSERA_BENEFICIARY_ID, else the setup nicknames). */
  env: Record<string, string | undefined>;
  /** Offline only: start this instance over, empty. */
  reset?: () => Promise<void>;
}

export interface Assembled extends Instance {
  /** Unresolved attempts found and settled when this instance started. */
  recovered: number;
}

export async function assemble(runtime: Runtime, options: AssembleOptions): Promise<Assembled> {
  const { offline, api, simulator, ledger, gateway, commander, closer, cards, model, readerName, agent, paidHoldMs, webhookSecret, offlineWebhooks, agentOnEvent } = runtime;
  const beneficiaryId = await resolveBeneficiary(api, options.env);
  // The funding demo incident pays the EUR supplier; without one the API still serves, and seeding says what to run.
  const eurBeneficiaryId = await resolveBeneficiary(api, options.env, "EUR").catch(() => null);
  // Anything left in INTENT by a crash is resolved before we accept traffic. A stuck or mismatching attempt is
  // escalated in the ledger, never a reason to refuse to start: log it and keep serving.
  let recovered = 0;
  try {
    recovered = (await gateway.recover()).length;
    await commander.recoverFunding();
  } catch (error) {
    console.error("startup recovery failed; serving anyway", error instanceof Error ? error.message : error);
  }

  // One gate for the console's agent runs and the event-driven ones; one reactor for webhooks and the sweep.
  const agentGate = new AgentGate();
  const wakes = agentOnEvent && agent ? new WakeScheduler({ ledger, gateway, commander, closer, model, agent, gate: agentGate }) : null;
  const reactor = new Reactor({ ledger, commander, wake: wakes ? (id, cause) => wakes.request(id, cause) : null });
  const webhook = webhookSecret ? createWebhookHandler({ ledger, gateway, secret: webhookSecret, reactor }) : undefined;
  // Offline deliveries go through the same route function the public listener serves.
  if (webhook) offlineWebhooks?.bind(publicWebhookRoutes(webhook));
  return {
    recovered,
    handle: createApi({
      ledger, gateway, commander, closer, cards, model, readerName, simulator, token: options.token, operator: options.operator, beneficiaryId, eurBeneficiaryId,
      paidHoldMs, agent, offline,
      payees: () => api.listBeneficiaries(),
      webhooks: { listening: webhook !== undefined, agentOnEvent: wakes !== null }, agentGate, reactor,
      reset: offline ? options.reset : undefined,
    }),
    webhook,
    sweep: async () => {
      // Each step runs even if another fails, so one stuck attempt never stops the rest from syncing. The reaction
      // comes last: whatever the sync saw change is reassessed exactly as a webhook would have had it.
      const failures: unknown[] = [];
      for (const step of [() => gateway.recover(), () => commander.recoverFunding(), () => gateway.sync(), () => reactor.react({ source: "sweep" }), () => cards.sync()]) {
        try {
          await step();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) throw failures[0];
    },
    stop: () => {
      wakes?.stop();
      // A live ledger is a file; close it so a rebuilt instance (new keys, eviction) owns it alone.
      if (!offline) ledger.close();
    },
  };
}
