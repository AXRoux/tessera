/**
 * `bun run doctor`: tells a new user, in one screen, what works, what does not, and the exact command to fix it.
 *
 *   bun run doctor              static checks only: no network, no keys used
 *   bun run doctor -- --live    also logs in to the Airwallex sandbox, finds the demo beneficiaries, and pings Claude
 *
 * Two tracks, because most people only need the first:
 *   offline demo   `bun run demo`   needs only Bun, Node and the installed dependencies
 *   live           `bun run dev`    needs sandbox keys, secrets and (for Claude) an Anthropic key
 * Exit code 1 only when the offline demo cannot start, or when --live was asked for and a live check failed.
 */
import { existsSync } from "node:fs";
import { AirwallexClient } from "../src/airwallex/client";
import { SPIKE_SUPPLIER } from "../src/airwallex/types";
import { parseHoldMs } from "../src/server/runtime";
import { DEFAULT_WEBHOOK_PORT } from "../src/server/webhook-listener";
import { tunnelProviders } from "./tunnel";

const live = process.argv.includes("--live");
const tty = Boolean(process.stdout.isTTY || process.env.FORCE_COLOR);
const paint = (code: string, text: string) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = (t: string) => paint("1", t);
const dim = (t: string) => paint("2", t);
const green = (t: string) => paint("32", t);
const red = (t: string) => paint("31", t);
const yellow = (t: string) => paint("33", t);

type Status = "ok" | "warn" | "fail";
const MARK: Record<Status, string> = { ok: green("✓"), warn: yellow("!"), fail: red("✗") };

interface Track {
  name: string;
  command: string;
  results: Array<{ status: Status; line: string }>;
}
const offline: Track = { name: "Offline demo", command: "bun run demo", results: [] };
const liveTrack: Track = { name: "Live (Airwallex sandbox)", command: "bun run dev", results: [] };

// A fix is only worth printing under a check that did not pass.
const note = (track: Track, status: Status, line: string, fix?: string) =>
  track.results.push({ status, line: fix && status !== "ok" ? `${line}\n      ${dim(`fix: ${fix}`)}` : line });

const env = process.env;

// ---- runtimes and dependencies (both tracks) -------------------------------------------------------------------
const [bunMajor = 0, bunMinor = 0] = Bun.version.split(".").map(Number);
note(offline, bunMajor > 1 || (bunMajor === 1 && bunMinor >= 4) ? "ok" : "fail", `Bun ${Bun.version}`, "install Bun 1.4 or newer: https://bun.sh");

const node = Bun.spawnSync(["node", "--version"], { stdout: "pipe", stderr: "pipe" });
const nodeVersion = node.exitCode === 0 ? node.stdout.toString().trim().replace(/^v/, "") : null;
const [nodeMajor = 0, nodeMinor = 0] = (nodeVersion ?? "0.0").split(".").map(Number);
const nodeOk = nodeMajor > 20 || (nodeMajor === 20 && nodeMinor >= 9);
note(offline, nodeOk ? "ok" : "fail", nodeVersion ? `Node ${nodeVersion} (the console runs on Next.js 16)` : "Node is not installed (the console runs on Next.js 16)", "install Node 20.9 or newer: https://nodejs.org");

note(offline, existsSync("node_modules") ? "ok" : "fail", "root dependencies", "bun install");
note(offline, existsSync("web/node_modules") ? "ok" : "fail", "console dependencies", "cd web && bun install");

// ---- ports (both tracks) -------------------------------------------------------------------------------------
for (const [label, name, fallback] of [["API", "TESSERA_API_PORT", "4010"], ["console", "TESSERA_WEB_PORT", "3100"]] as const) {
  const port = Number(env[name] || fallback);
  let free = true;
  try {
    Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }).stop(true);
  } catch {
    free = false;
  }
  note(offline, free ? "ok" : "warn", `${label} port ${port} is ${free ? "free" : "in use"}`, free ? undefined : `stop what is using it, or set ${name}=<another port>`);
}

// ---- live track: configuration -------------------------------------------------------------------------------
const secret = env.TESSERA_APPROVAL_SECRET ?? "";
note(liveTrack, secret.length >= 32 ? "ok" : "fail", "TESSERA_APPROVAL_SECRET (32+ characters)", "bun run setup  (generates it)");
note(liveTrack, env.TESSERA_API_TOKEN ? "ok" : "fail", "TESSERA_API_TOKEN", "bun run setup  (generates it)");
const haveAirwallex = Boolean(env.AWX_CLIENT_ID && env.AWX_API_KEY);
note(liveTrack, haveAirwallex ? "ok" : "fail", "Airwallex sandbox keys (AWX_CLIENT_ID, AWX_API_KEY)", "Airwallex sandbox web app > Account > Developer > API keys, then put them in .env");
const baseUrl = env.AWX_BASE_URL ?? "https://api.sandbox.airwallex.com";
note(liveTrack, baseUrl.includes("sandbox") ? "ok" : "fail", `AWX_BASE_URL is the sandbox (${baseUrl})`, "Tessera is sandbox-only: set AWX_BASE_URL=https://api.sandbox.airwallex.com");
try {
  const hold = parseHoldMs(env.TESSERA_PAID_HOLD_MS, 24 * 3600_000);
  note(liveTrack, "ok", `paid hold window ${hold === 24 * 3600_000 ? "24 h (production policy)" : `${hold} ms (shortened for a demo)`}`);
} catch (error) {
  note(liveTrack, "fail", error instanceof Error ? error.message : "TESSERA_PAID_HOLD_MS is invalid", "set a whole number of milliseconds, or leave it blank");
}

// Webhooks are optional live: without them the sweep still catches every change, only slower.
const haveWebhook = Boolean(env.AWX_WEBHOOK_SECRET && env.AWX_WEBHOOK_ID);
note(
  liveTrack,
  haveWebhook ? "ok" : "warn",
  haveWebhook ? "Airwallex webhook subscription configured (AWX_WEBHOOK_ID, AWX_WEBHOOK_SECRET)" : "no webhook subscription: bank events reach Tessera only through the sweep (every TESSERA_SWEEP_MS)",
  "optional: bun run dev -- --tunnel (creates the subscription on its first run and points it at every tunnel URL)",
);
const webhookPort = Number(env.TESSERA_WEBHOOK_PORT || DEFAULT_WEBHOOK_PORT);
let webhookPortFree = true;
try {
  Bun.listen({ hostname: "127.0.0.1", port: webhookPort, socket: { data() {} } }).stop(true);
} catch {
  webhookPortFree = false;
}
note(liveTrack, webhookPortFree ? "ok" : "warn", `webhook listener port ${webhookPort} is ${webhookPortFree ? "free" : "in use"}`, "stop what is using it, or set TESSERA_WEBHOOK_PORT=<another port>");
let providers: string[] = [];
let providerProblem: string | null = null;
try {
  providers = tunnelProviders(env.TESSERA_TUNNEL_PROVIDER || undefined, (binary) => Bun.which(binary) !== null, Boolean(env.TESSERA_WEBHOOK_SOURCE_IPS?.trim()));
} catch (error) {
  providerProblem = error instanceof Error ? error.message : String(error);
}
note(
  liveTrack,
  providers.length > 0 ? "ok" : "warn",
  providers.length > 0 ? `\`bun run dev -- --tunnel\` will try ${providers.join(", then ")}` : (providerProblem ?? "no tunnel provider: `bun run dev -- --tunnel` cannot give Airwallex a public URL"),
  "optional: brew install cloudflared (or have ssh on PATH for localhost.run)",
);
if (env.ANTHROPIC_API_KEY && env.TESSERA_MODEL) note(liveTrack, "ok", `Claude is configured (${env.TESSERA_MODEL})`);
else if (env.ANTHROPIC_API_KEY) note(liveTrack, "warn", "ANTHROPIC_API_KEY is set but TESSERA_MODEL is blank, so Claude stays off", "set TESSERA_MODEL=claude-sonnet-5-5");
else note(liveTrack, "warn", "no Anthropic key: the live console works, but evidence is entered by hand and there is no agent", "optional: set ANTHROPIC_API_KEY and TESSERA_MODEL");

// ---- live track: real calls, only with --live ----------------------------------------------------------------------
if (live && haveAirwallex && baseUrl.includes("sandbox")) {
  try {
    const client = AirwallexClient.fromEnv(env);
    const beneficiaries = await client.listBeneficiaries();
    note(liveTrack, "ok", "Airwallex sandbox login works");
    const found = beneficiaries.some((b) => b.nickname === SPIKE_SUPPLIER.nickname) || Boolean(env.TESSERA_BENEFICIARY_ID);
    note(liveTrack, found ? "ok" : "fail", `demo beneficiary "${SPIKE_SUPPLIER.nickname}" exists`, "bun run setup  (creates it in the sandbox)");
    if (env.AWX_WEBHOOK_ID) {
      const subscription = (await client.listWebhooks()).find((s) => s.id === env.AWX_WEBHOOK_ID);
      note(
        liveTrack,
        subscription ? "ok" : "warn",
        subscription ? `webhook subscription ${subscription.id} points at ${subscription.url}` : `webhook subscription ${env.AWX_WEBHOOK_ID} is not at Airwallex any more`,
        "bun run webhook:register -- --url <public URL>  (creates a new one)",
      );
    }
  } catch (error) {
    note(liveTrack, "fail", `Airwallex sandbox login failed: ${error instanceof Error ? error.message : String(error)}`, "check AWX_CLIENT_ID and AWX_API_KEY in .env");
  }
}
if (live && env.ANTHROPIC_API_KEY && env.TESSERA_MODEL) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: env.TESSERA_MODEL, max_tokens: 8, messages: [{ role: "user", content: "Reply with ok." }] }),
    signal: AbortSignal.timeout(20_000),
  }).catch((error: unknown) => error as Error);
  if (response instanceof Error) note(liveTrack, "fail", `could not reach Anthropic: ${response.message}`, "check your network");
  else if (response.ok) note(liveTrack, "ok", `Claude answers (${env.TESSERA_MODEL})`);
  else note(liveTrack, "fail", `Anthropic answered ${response.status}`, response.status === 404 ? "TESSERA_MODEL is not a model your key can use" : "check ANTHROPIC_API_KEY");
}

// ---- report ------------------------------------------------------------------------------------------------------
const ready = (track: Track) => track.results.every((r) => r.status !== "fail");
const offlineReady = offline.results.every((r) => r.status !== "fail");
console.log(`\n${bold("Tessera doctor")}${live ? dim("  (--live: real calls)") : dim("  (static checks; add `-- --live` to test your keys)")}\n`);
for (const track of [offline, liveTrack]) {
  console.log(`${bold(track.name)}  ${ready(track) ? green("ready") : red("not ready")}   ${dim(`→ ${track.command}`)}`);
  for (const { status, line } of track.results) console.log(`  ${MARK[status]} ${line}`);
  console.log("");
}
if (!offlineReady) {
  console.log(`${bold("Next:")} fix the ${red("✗")} lines under "Offline demo", then run ${bold("bun run demo")}.`);
} else if (ready(liveTrack)) {
  console.log(`${bold("Next:")} ${bold("bun run dev")} for the sandbox, or ${bold("bun run demo")} for the keyless demo.`);
} else {
  console.log(`${bold("Next:")} ${bold("bun run demo")} works right now, no keys needed. For the live sandbox, fix the ${red("✗")} lines above (${bold("bun run setup")} does most of it).`);
}
process.exit(!offlineReady || (live && !ready(liveTrack)) ? 1 : 0);
