/**
 * One command for the API and the console, with prefixed logs; stopping either stops both.
 *
 *   bun run demo   offline: simulated Airwallex, scripted agent (Claude if a key is set), a 6s hold, no keys needed
 *   bun run dev    live: the same two processes on the .env credentials
 *
 * Flags: --offline, --production (web runs `next start` on a built app), --host <address> (web bind address; the API
 * always stays on 127.0.0.1), --tunnel (live only, or TESSERA_TUNNEL=1: webhooks end to end, see below). The API token
 * is generated when unset and handed to both processes. The offline demo wakes the agent on bank events
 * (TESSERA_AGENT_ON_EVENT defaults to 1 there; set it to 0 to turn that off).
 *
 * --tunnel opens a public HTTPS tunnel to the webhook listener (never to the API or the console): cloudflared, falling
 * back to localhost.run over SSH when Cloudflare's edge is unreachable (scripts/tunnel.ts). A provider counts only once a
 * request through it reached the listener. Every URL it hands out is pointed at the Airwallex subscription
 * automatically (the secret does not change, so nothing restarts); with no subscription yet, one is created first and
 * its secret written to .env. A dropped tunnel is reopened and the new URL pointed at again.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AirwallexClient } from "../src/airwallex/client";
import { type Health, HealthSchema } from "../src/server/wire";
import { WEBHOOK_PATH } from "../src/server/webhook-listener";
import { Tunnel, tunnelProviders, waitForListener, type TunnelProvider } from "./tunnel";
import { describeSubscription, pointSubscription } from "./webhook-register";

const args = process.argv.slice(2);
const offline = args.includes("--offline");
const production = args.includes("--production");
const hostAt = args.indexOf("--host");
const webHost = hostAt >= 0 ? args[hostAt + 1] ?? "127.0.0.1" : "127.0.0.1";
const tunnel = args.includes("--tunnel") || process.env.TESSERA_TUNNEL === "1";
const root = join(import.meta.dir, "..");
const webDir = join(root, "web");

if (!existsSync(join(webDir, "node_modules"))) {
  console.error("web dependencies are missing: run `cd web && bun install` first");
  process.exit(1);
}

const webPort = process.env.TESSERA_WEB_PORT || "3100";
// Same default as src/server/webhook-listener.ts; the listener only runs live, with AWX_WEBHOOK_SECRET set.
const webhookPort = process.env.TESSERA_WEBHOOK_PORT || "4011";
const envFile = join(root, ".env");
const sandbox = (process.env.AWX_BASE_URL ?? "https://api.sandbox.airwallex.com").includes("sandbox");

if (tunnel && offline) {
  console.error("--tunnel is for live mode: offline, the simulated Airwallex delivers its webhooks in process and nothing needs a public URL");
  process.exit(1);
}
let providers: TunnelProvider[] = [];
if (tunnel) {
  try {
    providers = tunnelProviders(process.env.TESSERA_TUNNEL_PROVIDER || undefined, (binary) => Bun.which(binary) !== null, Boolean(process.env.TESSERA_WEBHOOK_SOURCE_IPS?.trim()));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
  if (providers.length === 0) {
    console.error(
      process.env.TESSERA_WEBHOOK_SOURCE_IPS?.trim()
        ? "--tunnel with TESSERA_WEBHOOK_SOURCE_IPS needs cloudflared (macOS: `brew install cloudflared`): only Cloudflare forwards the client address it checks"
        : "--tunnel needs cloudflared (macOS: `brew install cloudflared`) or ssh on PATH",
    );
    process.exit(1);
  }
  if (!process.env.AWX_WEBHOOK_SECRET && !sandbox) {
    console.error("--tunnel creates the webhook subscription only on the Airwallex sandbox; set AWX_WEBHOOK_SECRET and AWX_WEBHOOK_ID for this account");
    process.exit(1);
  }
}

const tunnelLog = (line: string): void => void process.stdout.write(`\x1b[33m[tunnel]\x1b[0m ${line}\n`);
let currentTunnel: Tunnel | null = null;
let stopping = false;

interface OpenTunnel {
  tunnel: Tunnel;
  base: string;
}

/**
 * Opens the providers in order until one hands out a URL through which a GET reaches the webhook port (the listener,
 * or the first-run stand-in below). A provider whose URL never does is blocked on this network.
 */
async function openWorkingTunnel(): Promise<OpenTunnel | null> {
  for (const [index, provider] of providers.entries()) {
    if (stopping) return null;
    const opened = new Tunnel(provider, webhookPort, tunnelLog);
    currentTunnel = opened;
    const base = await opened.next(0, 30_000);
    if (base && (await waitForListener(`${base}${WEBHOOK_PATH}`, 30_000))) return { tunnel: opened, base };
    opened.kill();
    await opened.exited;
    currentTunnel = null;
    const next = providers[index + 1];
    if (next) console.error(`[tunnel] ${provider} gave no URL that reaches this machine (blocked network?); trying ${next}`);
  }
  return null;
}

/**
 * First run: no subscription, so no secret, so no listener; and Airwallex creates a subscription only on a URL that
 * already resolves publicly ("Webhook destination resolves to an internal address" for a quick tunnel that never
 * connected, 2026-11-06). So a stand-in answers on the listener's port, exactly as the listener would to a GET, while a
 * tunnel is found; the subscription is created on that tunnel's URL, and the API starts with the secret it returned.
 */
let firstTunnel: OpenTunnel | null = null;
if (tunnel && !process.env.AWX_WEBHOOK_SECRET) {
  const standIn = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(webhookPort),
    fetch: (request) => new Response(null, { status: new URL(request.url).pathname === WEBHOOK_PATH ? 405 : 404 }),
  });
  firstTunnel = await openWorkingTunnel();
  await standIn.stop(true);
  if (!firstTunnel) {
    console.error("[tunnel] no provider reached this machine, so there is no public URL to create the webhook subscription on");
    process.exit(1);
  }
  try {
    const result = await pointSubscription(AirwallexClient.fromEnv(process.env), {
      url: `${firstTunnel.base}${WEBHOOK_PATH}`, ownId: process.env.AWX_WEBHOOK_ID || undefined, currentSecret: undefined, envFile,
    });
    process.env.AWX_WEBHOOK_ID = result.subscription.id;
    process.env.AWX_WEBHOOK_SECRET = result.newSecret ?? "";
    console.log(`  ${result.action} Airwallex subscription ${describeSubscription(result.subscription)}; AWX_WEBHOOK_ID and AWX_WEBHOOK_SECRET written to .env (secret not shown)`);
    if (result.action === "created") console.log("  A new subscription took about six minutes to start delivering (2026-11-03); the sweep covers the gap.");
  } catch (error) {
    console.error(`could not create the webhook subscription: ${error instanceof Error ? error.message : error}`);
    firstTunnel.tunnel.kill();
    process.exit(1);
  }
}
const listening = !offline && Boolean(process.env.AWX_WEBHOOK_SECRET);

/** A busy port otherwise surfaces as one child crashing and taking the other down with it, with no hint why. */
const ports: Array<[string, string, string]> = [
  ["API", process.env.TESSERA_API_PORT || "4010", "TESSERA_API_PORT"],
  ["console", webPort, "TESSERA_WEB_PORT"],
  ...(listening ? [["webhook listener", webhookPort, "TESSERA_WEBHOOK_PORT"] as [string, string, string]] : []),
];
for (const [label, port, variable] of ports) {
  try {
    Bun.listen({ hostname: "127.0.0.1", port: Number(port), socket: { data() {} } }).stop(true);
  } catch {
    console.error(`the ${label} port ${port} is already in use: stop what is using it, or set ${variable}`);
    process.exit(1);
  }
}
const apiPort = process.env.TESSERA_API_PORT || "4010";
const token = process.env.TESSERA_API_TOKEN || randomBytes(24).toString("hex");
const shared = { ...process.env, TESSERA_API_TOKEN: token, TESSERA_API_PORT: apiPort, FORCE_COLOR: "1" };
// The offline demo wakes the agent on bank events unless told not to; a public demo never does, so it is not asked to.
const wakeDefault = process.env.TESSERA_PUBLIC_DEMO ? {} : { TESSERA_AGENT_ON_EVENT: process.env.TESSERA_AGENT_ON_EVENT ?? "1" };
const apiEnv: Record<string, string | undefined> = offline
  ? { ...shared, TESSERA_OFFLINE: "1", TESSERA_PAID_HOLD_MS: "6000", ...wakeDefault }
  : shared;
const webEnv: Record<string, string | undefined> = { ...shared, TESSERA_API_URL: `http://127.0.0.1:${apiPort}` };

const children = [
  { name: "api", color: "34", essential: true, proc: Bun.spawn([process.execPath, "run", "src/server/main.ts"], { cwd: root, env: apiEnv, stdout: "pipe", stderr: "pipe" }) },
  {
    name: "web",
    color: "35",
    essential: true,
    proc: Bun.spawn(
      [process.execPath, "run", "next", production ? "start" : "dev", "-H", webHost, "-p", webPort],
      { cwd: webDir, env: webEnv, stdout: "pipe", stderr: "pipe" },
    ),
  },
];

/** Points the subscription at a tunnel URL that was just proven to reach the listener. */
async function announce(base: string): Promise<void> {
  const url = `${base}${WEBHOOK_PATH}`;
  console.log(`\n  \x1b[1mWebhook tunnel\x1b[0m  ${base} -> http://127.0.0.1:${webhookPort} (the webhook listener only)`);
  if (!sandbox || !process.env.AWX_WEBHOOK_ID) {
    console.log(`  Point Airwallex at it:  bun run webhook:register -- --url ${url}\n`);
    return;
  }
  try {
    const result = await pointSubscription(AirwallexClient.fromEnv(process.env), {
      url, ownId: process.env.AWX_WEBHOOK_ID, currentSecret: process.env.AWX_WEBHOOK_SECRET, envFile,
    });
    console.log(`  Airwallex subscription ${result.subscription.id} ${result.action === "unchanged" ? "already points here" : "now points here"}: webhooks are live.`);
    if (result.action === "updated") {
      console.log("  Airwallex took up to about three minutes to follow a URL change (2026-11-06). Deliveries meanwhile go to the old URL and come back in its next retry round; the sweep catches the change sooner.");
    }
    if (result.newSecret) console.log("  Its secret is not the one this API verifies with: the new one is in .env; restart this command to use it.");
    console.log("");
  } catch (error) {
    console.error(`  could not point the subscription here (${error instanceof Error ? error.message : error}); run: bun run webhook:register -- --url ${url}\n`);
  }
}

/**
 * Keeps one working tunnel open for as long as this runs: every URL it hands out is pointed at, and a tunnel that drops
 * is reopened (back-off doubling to a minute, reset once one has stayed up a minute).
 */
async function superviseTunnel(opened: OpenTunnel | null): Promise<void> {
  if (!(await waitForListener(`http://127.0.0.1:${webhookPort}${WEBHOOK_PATH}`, 120_000))) {
    console.error(`[tunnel] the webhook listener never answered on port ${webhookPort}; no tunnel opened`);
    opened?.tunnel.kill();
    return;
  }
  let backoffMs = 2_000;
  while (!stopping) {
    const open = opened ?? (await openWorkingTunnel());
    opened = null;
    if (stopping) return;
    if (!open) {
      console.error("[tunnel] no provider got through: webhooks cannot reach this machine (the sweep still catches every change); retrying in 60s");
      await Bun.sleep(60_000);
      continue;
    }
    const since = Date.now();
    await announce(open.base);
    for (let seen = 1; !stopping; seen++) {
      const base = await open.tunnel.next(seen);
      if (base === null) break;
      if (await waitForListener(`${base}${WEBHOOK_PATH}`, 30_000)) await announce(base);
      else console.error(`[tunnel] ${base} does not reach the listener; the subscription keeps the previous URL`);
    }
    open.tunnel.kill();
    await open.tunnel.exited;
    currentTunnel = null;
    if (stopping) return;
    if (Date.now() - since > 60_000) backoffMs = 2_000;
    console.error(`[tunnel] ${open.tunnel.provider} dropped; reopening in ${backoffMs / 1000}s, and the new URL is pointed at automatically`);
    await Bun.sleep(backoffMs);
    backoffMs = Math.min(backoffMs * 2, 60_000);
  }
}

async function pipe(stream: ReadableStream<Uint8Array>, prefix: string, out: NodeJS.WriteStream): Promise<void> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) out.write(`${prefix} ${line}\n`);
  }
  if (pending) out.write(`${prefix} ${pending}\n`);
}

for (const { name, color, proc } of children) {
  const prefix = `\x1b[${color}m[${name}]\x1b[0m`;
  void pipe(proc.stdout, prefix, process.stdout);
  void pipe(proc.stderr, prefix, process.stderr);
}

function stopAll(code: number): void {
  if (stopping) return;
  stopping = true;
  currentTunnel?.kill();
  for (const { proc } of children) proc.kill("SIGTERM");
  setTimeout(() => {
    for (const { proc } of children) proc.kill("SIGKILL");
    process.exit(code);
  }, 3_000).unref();
  void Promise.all(children.map((c) => c.proc.exited)).then(() => process.exit(code));
}

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));
for (const { name, proc } of children) {
  void proc.exited.then((code) => {
    if (stopping) return;
    console.error(`[${name}] exited with code ${code}; stopping the other processes`);
    stopAll(code ?? 1);
  });
}

console.log(
  `tessera ${offline ? "offline demo (simulated Airwallex, no money moves)" : "dev"}: console http://${webHost === "0.0.0.0" ? "localhost" : webHost}:${webPort}  ·  api http://127.0.0.1:${apiPort}  ·  Ctrl-C stops both`,
);

/**
 * Wait until both processes answer, then say what to do next, and (for an interactive offline demo) open the console.
 * The console renders from the API, so opening it before the API is up would show an error page.
 */
async function whenReady(): Promise<void> {
  const consoleUrl = `http://${webHost === "0.0.0.0" ? "localhost" : webHost}:${webPort}`;
  const deadline = Date.now() + 120_000;
  let health: Pick<Health, "agent" | "agentOnEvent"> | null = null;
  while (!stopping && Date.now() < deadline) {
    try {
      const api = await fetch(`http://127.0.0.1:${apiPort}/api/health`, { headers: { "x-tessera-token": token }, signal: AbortSignal.timeout(2_000) });
      const page = await fetch(`http://127.0.0.1:${webPort}/`, { signal: AbortSignal.timeout(5_000) });
      if (api.ok && page.ok) {
        health = HealthSchema.pick({ agent: true, agentOnEvent: true }).parse(await api.json());
        break;
      }
    } catch {
      /* not up yet */
    }
    await Bun.sleep(500);
  }
  if (!health || stopping) return;

  const agent = health.agent?.kind === "model" ? `${health.agent.name} (your key)` : health.agent?.kind === "scripted" ? "a deterministic script, not a model" : "none configured";
  console.log(`\n  \x1b[1mReady.\x1b[0m  Open  \x1b[1m${consoleUrl}\x1b[0m`);
  if (offline) {
    console.log(`  New here? The page opens with a "Start here" checklist: load seven incidents, watch the agent work them, try to break it.`);
    console.log(`  Agent in this demo: ${agent}.${health.agent?.kind === "scripted" ? " Configure a model in .env (Claude or any OpenAI-compatible one) to use it instead." : ""}`);
    if (health.agentOnEvent) console.log(`  Open an incident and press "Fail the transfer": the simulated Airwallex sends a signed webhook, the decision changes, and the agent wakes for that incident on its own.`);
  }
  console.log("");

  const interactive = Boolean(process.stdout.isTTY) && !process.env.CI && !process.env.TESSERA_NO_OPEN && !args.includes("--no-open");
  if (offline && interactive && webHost !== "0.0.0.0") {
    const opener = process.platform === "darwin" ? ["open"] : process.platform === "win32" ? ["cmd", "/c", "start", ""] : ["xdg-open"];
    try {
      Bun.spawn([...opener, consoleUrl], { stdout: "ignore", stderr: "ignore" });
    } catch {
      /* no browser opener on this machine: the URL above is enough */
    }
  }
}
void whenReady();
if (tunnel) void superviseTunnel(firstTunnel);
