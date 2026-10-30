/**
 * Tessera API process. Holds every credential (Airwallex, approval signing, Anthropic); the Next.js app talks to it
 * server-side with TESSERA_API_TOKEN, so no secret ever reaches a browser.
 *
 *   bun run api                         live: Airwallex (sandbox by default) and, with a key, Claude
 *   TESSERA_OFFLINE=1 bun run api       simulated Airwallex in-process, scripted agent unless a Claude key is set
 *                                       (can be reset to empty from the console; TESSERA_DEMO_IDLE_RESET_MS resets it when idle)
 */
import { createApi, MAX_REQUEST_BODY_BYTES } from "./api";
import { resettable, type Instance } from "./resettable";
import { buildRuntime, resolveBeneficiary } from "./runtime";

const first = buildRuntime();
for (const warning of first.warnings) console.warn(`warning: ${warning}`);

if (!first.apiToken) throw new Error("TESSERA_API_TOKEN is not set (see .env.example)");
// Chosen once: a reset builds a fresh runtime, and the console must keep working through it.
const token = first.apiToken;
const operator = process.env.TESSERA_OPERATOR ?? "operator";
const port = Number(process.env.TESSERA_API_PORT ?? 4010);
const sweepSetting = process.env.TESSERA_SWEEP_MS?.trim();
const sweepMs = sweepSetting ? Number(sweepSetting) : 60_000;
if (!Number.isSafeInteger(sweepMs) || sweepMs < 0) throw new Error(`TESSERA_SWEEP_MS must be a whole number of milliseconds >= 0 (got "${sweepSetting}")`);
const idleSetting = process.env.TESSERA_DEMO_IDLE_RESET_MS?.trim();
const idleResetMs = idleSetting ? Number(idleSetting) : 0;
if (!Number.isSafeInteger(idleResetMs) || idleResetMs < 0) throw new Error(`TESSERA_DEMO_IDLE_RESET_MS must be a whole number of milliseconds >= 0 (got "${idleSetting}")`);
if (idleResetMs > 0 && !first.offline) throw new Error("TESSERA_DEMO_IDLE_RESET_MS only applies to the offline demo: a live ledger is never thrown away");

// The first instance is the runtime built above (so startup builds one, not two); every reset builds a fresh one.
let pending: typeof first | null = first;
let recoveredAtStart = 0;
const nextRuntime = () => {
  const runtime = pending ?? buildRuntime({ ...process.env, TESSERA_API_TOKEN: token });
  pending = null;
  return runtime;
};

async function build(): Promise<Instance> {
  const isFirst = pending !== null;
  const { offline, api, simulator, ledger, gateway, commander, closer, model, agent, paidHoldMs, webhookSecret } = nextRuntime();
  const beneficiaryId = await resolveBeneficiary(api);
  // Anything left in INTENT by a crash is resolved before we accept traffic. A stuck or mismatching attempt is
  // escalated in the ledger, never a reason to refuse to start: log it and keep serving.
  let recovered = 0;
  try {
    recovered = (await gateway.recover()).length;
  } catch (error) {
    console.error("startup recovery failed; serving anyway", error instanceof Error ? error.message : error);
  }
  if (isFirst) recoveredAtStart = recovered;
  return {
    handle: createApi({
      ledger, gateway, commander, closer, model, simulator, token, operator, beneficiaryId, paidHoldMs, agent, offline, webhookSecret,
      reset: offline ? () => demo.reset() : undefined,
    }),
    sweep: async () => {
      // Each half runs even if the other fails, so one stuck attempt never stops the rest from syncing.
      const failures: unknown[] = [];
      for (const step of [() => gateway.recover(), () => gateway.sync()]) {
        try {
          await step();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) throw failures[0];
    },
  };
}

const demo = await resettable(build);
const { offline, dbPath, paidHoldMs, simulator, model, agent, webhookSecret } = first;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  // Agent runs stream for a minute or more; the default 10s idle timer would cut them off between model turns.
  idleTimeout: 255,
  // Bun's default is 128 MB, and the webhook route is reachable without the operator token through a tunnel.
  maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
  fetch: demo.handle,
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
      await demo.sweep();
    } catch (error) {
      console.error("sweep failed", error instanceof Error ? error.message : error);
    } finally {
      sweeping = false;
    }
  }, sweepMs);
}

// A shared public demo is left in whatever state the last visitor made of it; start the next one clean.
if (idleResetMs > 0) {
  setInterval(() => {
    if (demo.idleMs() > idleResetMs) void demo.reset().then(() => console.log("demo was idle; reset to empty"));
  }, Math.min(30_000, idleResetMs)).unref();
}

const agentLabel = agent ? (agent.kind === "scripted" ? "scripted, not Claude" : `Claude (${process.env.TESSERA_MODEL})`) : "off";
const readerLabel = model ? (agent?.kind === "scripted" ? "offline keyword reader, not Claude" : "Claude") : "off";
console.log(`tessera api  http://${server.hostname}:${server.port}${offline ? "  ·  OFFLINE: simulated Airwallex, no money moves" : ""}`);
console.log(`  ledger ${dbPath}  |  recovered ${recoveredAtStart} unresolved attempt(s)  |  hold ${paidHoldMs}ms`);
console.log(`  agent ${agentLabel}  |  reader ${readerLabel}  |  simulator ${simulator ? "on" : "off"}  |  webhooks ${webhookSecret ? "on" : "off"}  |  sweep ${sweepMs > 0 ? `${sweepMs}ms` : "off"}${offline ? `  |  reset on${idleResetMs > 0 ? ` (idle ${idleResetMs}ms)` : ""}` : ""}`);
if (first.generatedToken) {
  console.log(`  generated API token for this process (set TESSERA_API_TOKEN to choose one): ${token}`);
}
