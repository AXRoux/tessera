/**
 * Tessera API process. Holds every credential (Airwallex, approval signing, Anthropic); the Next.js app talks to it
 * server-side with TESSERA_API_TOKEN, so no secret ever reaches a browser.
 */
import { createApi, type Simulator } from "./api";
import { buildRuntime, required } from "./runtime";

const token = required("TESSERA_API_TOKEN");
const operator = process.env.TESSERA_OPERATOR ?? "operator";
const port = Number(process.env.TESSERA_API_PORT ?? 4010);

const { dbPath, paidHoldMs, client, ledger, gateway, commander, closer, model, sandbox } = buildRuntime();

const simulator: Simulator | null = sandbox
  ? { advance: (transferId, status, failureType) => client.simulateTransition(transferId, status, failureType) }
  : null;

const beneficiaryId =
  process.env.TESSERA_BENEFICIARY_ID ?? (await client.listBeneficiaries()).find((b) => b.nickname === "spike-us-supplier")?.id;
if (!beneficiaryId) throw new Error("set TESSERA_BENEFICIARY_ID, or create a sandbox beneficiary nicknamed spike-us-supplier");

// Anything left in INTENT by a crash is resolved before we accept traffic.
const resolved = await gateway.recover();

const agent = model ? { model, actor: process.env.TESSERA_AGENT_NAME ?? "agent:claude" } : null;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  // Agent runs stream for a minute or more; the default 10s idle timer would cut them off between model turns.
  idleTimeout: 255,
  fetch: createApi({ ledger, gateway, commander, closer, model, simulator, token, operator, beneficiaryId, paidHoldMs, agent }),
});

console.log(`tessera api  http://${server.hostname}:${server.port}`);
console.log(`  ledger ${dbPath}  |  recovered ${resolved.length} unresolved attempt(s)`);
console.log(`  model ${model ? process.env.TESSERA_MODEL : "not configured"}  |  sandbox controls ${simulator ? "on" : "off"}  |  hold ${paidHoldMs}ms`);
