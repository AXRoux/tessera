/**
 * Tessera API process. Holds every credential (Airwallex, approval signing, Anthropic); the Next.js app talks to it
 * server-side with TESSERA_API_TOKEN, so no secret ever reaches a browser.
 *
 *   bun run api                         live: Airwallex (sandbox by default) and, with a key, Claude
 *   TESSERA_OFFLINE=1 bun run api       simulated Airwallex in-process, scripted agent unless a Claude key is set
 */
import { createApi } from "./api";
import { buildRuntime, resolveBeneficiary } from "./runtime";

const runtime = buildRuntime();
const { offline, dbPath, paidHoldMs, api, simulator, ledger, gateway, commander, closer, model, agent, webhookSecret } = runtime;
for (const warning of runtime.warnings) console.warn(`warning: ${warning}`);

if (!runtime.apiToken) throw new Error("TESSERA_API_TOKEN is not set (see .env.example)");
const token = runtime.apiToken;
const operator = process.env.TESSERA_OPERATOR ?? "operator";
const port = Number(process.env.TESSERA_API_PORT ?? 4010);
const sweepSetting = process.env.TESSERA_SWEEP_MS?.trim();
const sweepMs = sweepSetting ? Number(sweepSetting) : 60_000;
if (!Number.isSafeInteger(sweepMs) || sweepMs < 0) throw new Error(`TESSERA_SWEEP_MS must be a whole number of milliseconds >= 0 (got "${sweepSetting}")`);

const beneficiaryId = await resolveBeneficiary(api);

// Anything left in INTENT by a crash is resolved before we accept traffic.
const resolved = await gateway.recover();

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  // Agent runs stream for a minute or more; the default 10s idle timer would cut them off between model turns.
  idleTimeout: 255,
  fetch: createApi({
    ledger, gateway, commander, closer, model, simulator, token, operator, beneficiaryId, paidHoldMs, agent, offline, webhookSecret,
  }),
});

/**
 * The background sweep: resolve stray intents, then pull every live transfer's state. Webhooks only make this faster;
 * a missed webhook is caught here. One sweep at a time.
 */
let sweeping = false;
if (sweepMs > 0) {
  setInterval(async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      await gateway.recover();
      await gateway.sync();
    } catch (error) {
      console.error("sweep failed", error instanceof Error ? error.message : error);
    } finally {
      sweeping = false;
    }
  }, sweepMs);
}

const agentLabel = agent ? (agent.kind === "scripted" ? "scripted, not Claude" : `Claude (${process.env.TESSERA_MODEL})`) : "off";
const readerLabel = model ? (agent?.kind === "scripted" ? "offline keyword reader, not Claude" : "Claude") : "off";
console.log(`tessera api  http://${server.hostname}:${server.port}${offline ? "  ·  OFFLINE: simulated Airwallex, no money moves" : ""}`);
console.log(`  ledger ${dbPath}  |  recovered ${resolved.length} unresolved attempt(s)  |  hold ${paidHoldMs}ms`);
console.log(`  agent ${agentLabel}  |  reader ${readerLabel}  |  simulator ${simulator ? "on" : "off"}  |  webhooks ${webhookSecret ? "on" : "off"}  |  sweep ${sweepMs > 0 ? `${sweepMs}ms` : "off"}`);
if (runtime.generatedToken) {
  console.log(`  generated API token for this process (set TESSERA_API_TOKEN to choose one): ${token}`);
}
