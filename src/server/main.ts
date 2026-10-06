/**
 * PayOnce API process. Holds every credential (Airwallex, approval signing, Anthropic); the Next.js app talks to it
 * server-side with PAYONCE_API_TOKEN, so no secret ever reaches a browser.
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
import { createApi, type Simulator } from "./api";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
}

const approvalSecret = required("PAYONCE_APPROVAL_SECRET");
const token = required("PAYONCE_API_TOKEN");
const operator = process.env.PAYONCE_OPERATOR ?? "operator";
const dbPath = process.env.PAYONCE_DB ?? ".data/payonce.db";
const port = Number(process.env.PAYONCE_API_PORT ?? 4010);
const paidHoldMs = Number(process.env.PAYONCE_PAID_HOLD_MS ?? 24 * 3600_000);

mkdirSync(dirname(dbPath), { recursive: true });
const client = AirwallexClient.fromEnv();
const ledger = new Ledger(dbPath);
const gateway = new PayoutGateway({ ledger, api: client, approvalSecret });
// One hold window for both: what the Commander tells the operator to wait for is what the Closer enforces.
const commander = new Commander({ ledger, gateway, balances: client, secret: approvalSecret, policy: { ...DEFAULT_POLICY, paidHoldMs } });
const closer = new Closer({ ledger, api: client, secret: approvalSecret, paidHoldMs });

const sandbox = (process.env.AWX_BASE_URL ?? "https://api.sandbox.airwallex.com").includes("sandbox");
const simulator: Simulator | null = sandbox
  ? { advance: (transferId, status, failureType) => client.simulateTransition(transferId, status, failureType) }
  : null;

const model = process.env.ANTHROPIC_API_KEY && process.env.PAYONCE_MODEL ? AnthropicModel.fromEnv() : null;

const beneficiaryId =
  process.env.PAYONCE_BENEFICIARY_ID ?? (await client.listBeneficiaries()).find((b) => b.nickname === "spike-us-supplier")?.id;
if (!beneficiaryId) throw new Error("set PAYONCE_BENEFICIARY_ID, or create a sandbox beneficiary nicknamed spike-us-supplier");

// Anything left in INTENT by a crash is resolved before we accept traffic.
const resolved = await gateway.recover();

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: createApi({ ledger, gateway, commander, closer, model, simulator, token, operator, beneficiaryId, paidHoldMs }),
});

console.log(`payonce api  http://${server.hostname}:${server.port}`);
console.log(`  ledger ${dbPath}  |  recovered ${resolved.length} unresolved attempt(s)`);
console.log(`  model ${model ? process.env.PAYONCE_MODEL : "not configured"}  |  sandbox controls ${simulator ? "on" : "off"}  |  hold ${paidHoldMs}ms`);
