/**
 * `bun run mcp`: Tessera's tools over stdio for any MCP client. Logs to stderr; stdout is protocol only.
 *
 * With TESSERA_OFFLINE=1 the server runs on the simulated Airwallex with no keys and no money, and starts with the
 * seven ACME demo incidents already in the ledger, so a client has something to work. TESSERA_MCP_SEED=0 starts it empty.
 */
import { seedAcme } from "../demo/scenario";
import { buildRuntime, resolveBeneficiary } from "../server/runtime";
import { serveStdio } from "./mcp";
import { createToolbox } from "./toolbox";

const { offline, api, simulator, ledger, gateway, commander, closer, cards, model, dbPath } = buildRuntime();
const actor = process.env.TESSERA_AGENT_NAME ?? "agent:mcp";
const authorityEnv = process.env.TESSERA_AGENT_AUTHORITY ?? "operator";
if (authorityEnv !== "operator" && authorityEnv !== "triage") throw new Error("TESSERA_AGENT_AUTHORITY must be operator or triage");
const authority: "operator" | "triage" = authorityEnv;

// Anything left in INTENT by a crash (payouts and funding conversions) is resolved before the first tool call. A stuck
// or mismatching one is escalated in the ledger; it is logged here and never a reason to refuse to serve.
let recovered = 0;
try {
  recovered = (await gateway.recover()).length;
  await commander.recoverFunding();
} catch (error) {
  console.error("startup recovery failed; serving anyway:", error instanceof Error ? error.message : error);
}

let seeded = 0;
if (offline && simulator && process.env.TESSERA_MCP_SEED !== "0") {
  const beneficiaries = { USD: await resolveBeneficiary(api), EUR: await resolveBeneficiary(api, process.env, "EUR") };
  const seed = () => seedAcme({ ledger, gateway, commander, simulator, approver: process.env.TESSERA_OPERATOR ?? "operator" }, beneficiaries);
  seeded = (await (simulator.withoutEvents ? simulator.withoutEvents(seed) : seed())).length;
}
console.error(`tessera mcp  ledger ${dbPath}  |  actor ${actor}  |  authority ${authority}  |  reader ${model ? "on" : "off"}  |  recovered ${recovered}${offline ? `  |  OFFLINE: simulated Airwallex, ${seeded} demo incidents` : ""}`);

await serveStdio(createToolbox({ ledger, gateway, commander, closer, cards, model, actor, authority, acceptClientText: true }));
