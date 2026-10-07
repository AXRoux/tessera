/**
 * Wires the real collaborators from the environment. Shared by every process that works the same ledger: the HTTP
 * API behind the web console and the MCP server. Both open `TESSERA_DB`, and the one-open-attempt index is what keeps
 * them honest when they run at the same time.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AirwallexClient } from "../airwallex/client";
import { Closer } from "../closer/closer";
import { AnthropicModel } from "../commander/anthropic";
import { Commander } from "../commander/commander";
import { DEFAULT_POLICY } from "../commander/policy";
import { PayoutGateway } from "../gateway/gateway";
import { Ledger } from "../ledger/ledger";

export function required(name: string, env: Record<string, string | undefined> = process.env): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
}

export function buildRuntime(env: Record<string, string | undefined> = process.env) {
  const approvalSecret = required("TESSERA_APPROVAL_SECRET", env);
  const dbPath = env.TESSERA_DB ?? ".data/tessera.db";
  const paidHoldMs = Number(env.TESSERA_PAID_HOLD_MS ?? 24 * 3600_000);

  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const client = AirwallexClient.fromEnv();
  const ledger = new Ledger(dbPath);
  const gateway = new PayoutGateway({ ledger, api: client, approvalSecret });
  // One hold window for both: what the Commander tells the operator to wait for is what the Closer enforces.
  const commander = new Commander({ ledger, gateway, balances: client, secret: approvalSecret, policy: { ...DEFAULT_POLICY, paidHoldMs } });
  const closer = new Closer({ ledger, api: client, secret: approvalSecret, paidHoldMs });
  const model = env.ANTHROPIC_API_KEY && env.TESSERA_MODEL ? AnthropicModel.fromEnv(env) : null;
  const sandbox = (env.AWX_BASE_URL ?? "https://api.sandbox.airwallex.com").includes("sandbox");

  return { approvalSecret, dbPath, paidHoldMs, client, ledger, gateway, commander, closer, model, sandbox };
}
