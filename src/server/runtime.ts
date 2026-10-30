/**
 * Wires the real collaborators from the environment. Shared by every process that works the same ledger: the HTTP
 * API behind the web console and the MCP server. Both open `TESSERA_DB`, and the one-open-attempt index is what keeps
 * them honest when they run at the same time.
 *
 * `TESSERA_OFFLINE=1` swaps Airwallex for the in-process simulator (src/airwallex/fake.ts) and, without an Anthropic
 * key, Claude for a deterministic scripted agent and keyword reader. Everything else (ledger, gateway, Commander,
 * Closer, toolbox) is the same code. No money and no network.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AirwallexClient } from "../airwallex/client";
import { FakePayoutApi } from "../airwallex/fake";
import type { BalanceApi, BeneficiaryApi, PayoutApi, ReconciliationApi } from "../airwallex/types";
import { Closer } from "../closer/closer";
import { AnthropicModel } from "../commander/anthropic";
import { Commander } from "../commander/commander";
import type { StructuredModel } from "../commander/evidence";
import { DEFAULT_POLICY } from "../commander/policy";
import { OfflineReader } from "../demo/offline-reader";
import { ScriptedAgentModel } from "../demo/scripted-agent";
import { PayoutGateway } from "../gateway/gateway";
import { Ledger } from "../ledger/ledger";
import type { AgentDeps, Simulator } from "./api";

type Env = Record<string, string | undefined>;

/** Everything Tessera needs from Airwallex, real or simulated. */
export type AirwallexApi = PayoutApi & ReconciliationApi & BalanceApi & BeneficiaryApi;

export interface RuntimeOptions {
  /** Wraps the Airwallex client and the simulator, e.g. to rate-limit a sandbox run. */
  wrap?: <T extends object>(target: T) => T;
}

const DEFAULT_HOLD_MS = 24 * 3600_000;
/** Offline, certification has to be demoable: a 6s hold instead of a day. */
const OFFLINE_HOLD_MS = 6_000;

/** Beneficiaries of the offline simulator, under the nicknames `bun run setup` creates in the sandbox. */
export const OFFLINE_BENEFICIARIES = [
  { id: "offline-us-supplier", nickname: "spike-us-supplier" },
  { id: "offline-eu-supplier", nickname: "spike-eu-supplier" },
];

export function required(name: string, env: Env = process.env): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
}

const truthy = (value: string | undefined): boolean => value === "1" || value?.toLowerCase() === "true";

/** TESSERA_OFFLINE=1: simulated Airwallex in-process. */
export const isOffline = (env: Env = process.env): boolean => truthy(env.TESSERA_OFFLINE);

/** TESSERA_PAID_HOLD_MS: blank means the default; anything else must be a whole number of milliseconds >= 0. */
export function parseHoldMs(setting: string | undefined, fallback: number): number {
  const trimmed = setting?.trim();
  if (!trimmed) return fallback;
  const value = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(value)) {
    throw new Error(`TESSERA_PAID_HOLD_MS must be a whole number of milliseconds >= 0 (got "${setting}")`);
  }
  return value;
}

/**
 * The sandbox simulator as the fake plays it: FAILED is followed at once by CANCELLED (funds back), which the real
 * sandbox does by itself a few seconds later.
 */
export function offlineSimulator(fake: FakePayoutApi): Simulator {
  return {
    async advance(transferId, status, failureType) {
      fake.advance(transferId, status, failureType);
      if (status === "FAILED") fake.advance(transferId, "CANCELLED");
    },
  };
}

/**
 * The beneficiary a currency's demo invoices pay. USD honours TESSERA_BENEFICIARY_ID, then the `spike-us-supplier`
 * nickname; EUR uses `spike-eu-supplier`. Both are created by `bun run setup`.
 */
export async function resolveBeneficiary(api: Pick<BeneficiaryApi, "listBeneficiaries">, env: Env = process.env, currency: "USD" | "EUR" = "USD"): Promise<string> {
  if (currency === "USD" && env.TESSERA_BENEFICIARY_ID) return env.TESSERA_BENEFICIARY_ID;
  const nickname = currency === "USD" ? "spike-us-supplier" : "spike-eu-supplier";
  const found = (await api.listBeneficiaries()).find((b) => b.nickname === nickname)?.id;
  if (!found) {
    throw new Error(
      `no ${currency} beneficiary: run \`bun run setup\` to create ${nickname} in the sandbox${currency === "USD" ? ", or set TESSERA_BENEFICIARY_ID" : ""}`,
    );
  }
  return found;
}

export function buildRuntime(env: Env = process.env, options: RuntimeOptions = {}) {
  const offline = isOffline(env);
  const publicDemo = truthy(env.TESSERA_PUBLIC_DEMO);
  if (publicDemo && !offline) throw new Error("TESSERA_PUBLIC_DEMO=1 is only allowed with TESSERA_OFFLINE=1: a public console must never reach real money");
  const wrap = options.wrap ?? (<T extends object>(target: T) => target);
  const warnings: string[] = [];

  // Offline, missing secrets are generated for this process: there is nothing for them to protect beyond the demo.
  const approvalSecret = offline ? env.TESSERA_APPROVAL_SECRET || randomBytes(32).toString("hex") : required("TESSERA_APPROVAL_SECRET", env);
  const apiToken = env.TESSERA_API_TOKEN || (offline ? randomBytes(24).toString("hex") : null);
  const generatedToken = !env.TESSERA_API_TOKEN && apiToken !== null;
  // The simulated Airwallex lives in memory, so an offline ledger does too: a file would outlive the transfers it names.
  const dbPath = offline ? ":memory:" : (env.TESSERA_DB ?? ".data/tessera.db");
  const paidHoldMs = parseHoldMs(env.TESSERA_PAID_HOLD_MS, offline ? OFFLINE_HOLD_MS : DEFAULT_HOLD_MS);

  let api: AirwallexApi;
  let simulator: Simulator | null;
  let sandbox: boolean;
  if (offline) {
    const fake = new FakePayoutApi({ beneficiaries: structuredClone(OFFLINE_BENEFICIARIES) });
    api = wrap(fake);
    simulator = wrap(offlineSimulator(fake));
    sandbox = false;
  } else {
    const client = AirwallexClient.fromEnv(env);
    sandbox = (env.AWX_BASE_URL ?? "https://api.sandbox.airwallex.com").includes("sandbox");
    api = wrap(client);
    simulator = sandbox ? wrap<Simulator>({ advance: (id, status, failureType) => client.simulateTransition(id, status, failureType) }) : null;
  }

  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const ledger = new Ledger(dbPath);
  const gateway = new PayoutGateway({ ledger, api, approvalSecret });
  // One hold window for both: what the Commander tells the operator to wait for is what the Closer enforces.
  const commander = new Commander({ ledger, gateway, balances: api, secret: approvalSecret, policy: { ...DEFAULT_POLICY, paidHoldMs } });
  const closer = new Closer({ ledger, api, gateway, secret: approvalSecret, paidHoldMs });

  if (env.ANTHROPIC_API_KEY && !env.TESSERA_MODEL) {
    warnings.push("ANTHROPIC_API_KEY is set but TESSERA_MODEL is not (e.g. claude-sonnet-5-5); Claude stays off");
  }
  const claude = env.ANTHROPIC_API_KEY && env.TESSERA_MODEL ? AnthropicModel.fromEnv(env) : null;
  let model: StructuredModel | null = claude;
  let agent: AgentDeps | null = claude ? { model: claude, actor: env.TESSERA_AGENT_NAME || "agent:claude", kind: "claude" } : null;
  if (!claude && offline) {
    model = new OfflineReader();
    // Never named after Claude, whatever TESSERA_AGENT_NAME says: the ledger must not credit a model that did not run.
    agent = { model: new ScriptedAgentModel(), actor: "agent:scripted", kind: "scripted" };
  }

  return {
    offline, publicDemo, sandbox, approvalSecret, apiToken, generatedToken, dbPath, paidHoldMs,
    api, simulator, ledger, gateway, commander, closer, model, agent, warnings,
    webhookSecret: env.AWX_WEBHOOK_SECRET || null,
  };
}
