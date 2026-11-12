/**
 * The single-operator API process (the default; see main.ts). Holds every credential (Airwallex, approval signing, the model's key); the Next.js app talks to it
 * server-side with TESSERA_API_TOKEN, so no secret ever reaches a browser.
 *
 *   bun run api                         live: Airwallex (sandbox by default) and, if configured, a model (Claude or any OpenAI-compatible one)
 *   TESSERA_OFFLINE=1 bun run api       simulated Airwallex in-process, scripted agent unless a model is configured
 *                                       (can be reset to empty from the console; TESSERA_DEMO_IDLE_RESET_MS resets it when idle)
 *
 * Live with AWX_WEBHOOK_SECRET set, a second listener on TESSERA_WEBHOOK_PORT (default 4011) serves Airwallex's
 * webhooks and nothing else; that port, never this API's, is the one to tunnel. Offline, the simulated Airwallex
 * delivers its signed events to the same route in process.
 */
import { MAX_REQUEST_BODY_BYTES } from "./api";
import { assemble } from "./instance";
import { resettable, type Instance } from "./resettable";
import { buildRuntime } from "./runtime";
import { DEFAULT_WEBHOOK_PORT, parseSourceAllowlist, startWebhookListener } from "./webhook-listener";

const first = buildRuntime();
for (const warning of first.warnings) console.warn(`warning: ${warning}`);

if (!first.apiToken) throw new Error("TESSERA_API_TOKEN is not set (see .env.example)");
// Chosen once: a reset builds a fresh runtime, and the console must keep working through it.
const token = first.apiToken;
const operator = process.env.TESSERA_OPERATOR ?? "operator";
const port = Number(process.env.TESSERA_API_PORT ?? 4010);
const sweepSetting = process.env.TESSERA_SWEEP_MS?.trim();
// At live pace a transfer can tip overdue within minutes, so the sweep looks every 15 seconds rather than every minute.
const sweepMs = sweepSetting ? Number(sweepSetting) : first.pace === "live" ? 15_000 : 60_000;
if (!Number.isSafeInteger(sweepMs) || sweepMs < 0) throw new Error(`TESSERA_SWEEP_MS must be a whole number of milliseconds >= 0 (got "${sweepSetting}")`);
const idleSetting = process.env.TESSERA_DEMO_IDLE_RESET_MS?.trim();
const idleResetMs = idleSetting ? Number(idleSetting) : 0;
if (!Number.isSafeInteger(idleResetMs) || idleResetMs < 0) throw new Error(`TESSERA_DEMO_IDLE_RESET_MS must be a whole number of milliseconds >= 0 (got "${idleSetting}")`);
if (idleResetMs > 0 && !first.offline) throw new Error("TESSERA_DEMO_IDLE_RESET_MS only applies to the offline demo: a live ledger is never thrown away");
const webhookPort = Number(process.env.TESSERA_WEBHOOK_PORT || DEFAULT_WEBHOOK_PORT);
if (!Number.isSafeInteger(webhookPort) || webhookPort <= 0 || webhookPort === port) {
  throw new Error(`TESSERA_WEBHOOK_PORT must be a port other than the API's (got "${process.env.TESSERA_WEBHOOK_PORT}")`);
}
const sourceAllowlist = parseSourceAllowlist(process.env.TESSERA_WEBHOOK_SOURCE_IPS);

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
  const instance = await assemble(nextRuntime(), { token, operator, env: process.env, reset: () => demo.reset() });
  if (isFirst) recoveredAtStart = instance.recovered;
  return instance;
}

const demo = await resettable(build);
const { offline, dbPath, paidHoldMs, simulator, model, readerName, agent, webhookSecret, agentOnEvent } = first;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  // Agent runs stream for a minute or more; the default 10s idle timer would cut them off between model turns.
  idleTimeout: 255,
  // Bun's default is 128 MB; nothing legitimate on the operator API is anywhere near that.
  maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
  fetch: demo.handle,
});

// Live only: offline, the simulated Airwallex delivers in process and nothing needs to reach this machine.
const listener = webhookSecret && !offline
  ? startWebhookListener({ port: webhookPort, handle: demo.webhook, ...(sourceAllowlist ? { allowedSources: sourceAllowlist } : {}) })
  : null;

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

const agentLabel = agent ? (agent.kind === "scripted" ? "scripted, not a model" : `${agent.name} (${process.env.TESSERA_MODEL})`) : "off";
const readerLabel = model ? (agent?.kind === "scripted" ? "offline keyword reader, not a model" : (readerName ?? "model")) : "off";
console.log(`tessera api  http://${server.hostname}:${server.port}${offline ? "  ·  OFFLINE: simulated Airwallex, no money moves" : ""}`);
console.log(`  ledger ${dbPath}  |  recovered ${recoveredAtStart} unresolved attempt(s)  |  hold ${paidHoldMs}ms  |  pace ${first.pace}${first.pace === "live" ? " (overdue after 5 min LOCAL / 10 min SWIFT)" : ""}`);
console.log(`  agent ${agentLabel}  |  reader ${readerLabel}  |  simulator ${simulator ? "on" : "off"}  |  webhooks ${webhookSecret ? (offline ? "simulated" : "on") : "off"}  |  agent on event ${agentOnEvent ? "on" : "off"}  |  sweep ${sweepMs > 0 ? `${sweepMs}ms` : "off"}${offline ? `  |  reset on${idleResetMs > 0 ? ` (idle ${idleResetMs}ms)` : ""}` : ""}`);
if (listener) {
  console.log(`  webhook listener  http://${listener.hostname}:${listener.port}/api/webhooks/airwallex  (POST only; tunnel THIS port, never ${port})${sourceAllowlist ? `  |  sources: ${sourceAllowlist.size} allowed IPs` : ""}`);
}
if (first.generatedToken) {
  console.log(`  generated API token for this process (set TESSERA_API_TOKEN to choose one): ${token}`);
}
