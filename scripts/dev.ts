/**
 * One command for the API and the console, with prefixed logs; stopping either stops both.
 *
 *   bun run demo   offline: simulated Airwallex, scripted agent (Claude if a key is set), a 6s hold, no keys needed
 *   bun run dev    live: the same two processes on the .env credentials
 *
 * Flags: --offline, --production (web runs `next start` on a built app), --host <address> (web bind address; the API
 * always stays on 127.0.0.1), --tunnel (live only, or TESSERA_TUNNEL=1: a Cloudflare quick tunnel to the webhook
 * listener, never to the API; prints its URL and the `webhook:register` line that points Airwallex at it). The API
 * token is generated when unset and handed to both processes. The offline demo wakes the agent on bank events
 * (TESSERA_AGENT_ON_EVENT defaults to 1 there; set it to 0 to turn that off).
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

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
const listening = !offline && Boolean(process.env.AWX_WEBHOOK_SECRET);

if (tunnel && offline) {
  console.error("--tunnel is for live mode: offline, the simulated Airwallex delivers its webhooks in process and nothing needs a public URL");
  process.exit(1);
}
if (tunnel && !Bun.which("cloudflared")) {
  console.error("--tunnel needs cloudflared on PATH (macOS: `brew install cloudflared`; others: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)");
  process.exit(1);
}

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
  // Losing the tunnel only slows reactions down to the sweep, so it does not take the API and console with it.
  ...(tunnel
    ? [{
        name: "tunnel",
        color: "33",
        essential: false,
        proc: Bun.spawn(["cloudflared", "tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${webhookPort}`], { cwd: root, stdout: "pipe", stderr: "pipe" }),
      }]
    : []),
];

/** A quick tunnel's hostname is random per run and is logged a few seconds after start, not on its first line. */
const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
let tunnelUrl: string | null = null;
function watchTunnel(line: string): void {
  const found = tunnelUrl === null ? TUNNEL_URL.exec(line)?.[0] : undefined;
  if (!found) return;
  tunnelUrl = found;
  console.log(`\n  \x1b[1mWebhook tunnel\x1b[0m  ${found} -> http://127.0.0.1:${webhookPort} (the webhook listener only)`);
  console.log(`  Point Airwallex at it:  bun run webhook:register -- --url ${found}/api/webhooks/airwallex`);
  if (!listening) console.log("  AWX_WEBHOOK_SECRET is not set yet: the first register writes it; then restart this command (and register the new URL).");
  console.log("");
}

async function pipe(stream: ReadableStream<Uint8Array>, prefix: string, out: NodeJS.WriteStream, onLine?: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      out.write(`${prefix} ${line}\n`);
      onLine?.(line);
    }
  }
  if (pending) out.write(`${prefix} ${pending}\n`);
}

for (const { name, color, proc } of children) {
  const prefix = `\x1b[${color}m[${name}]\x1b[0m`;
  const onLine = name === "tunnel" ? watchTunnel : undefined;
  void pipe(proc.stdout, prefix, process.stdout, onLine);
  void pipe(proc.stderr, prefix, process.stderr, onLine);
}

let stopping = false;
function stopAll(code: number): void {
  if (stopping) return;
  stopping = true;
  for (const { proc } of children) proc.kill("SIGTERM");
  setTimeout(() => {
    for (const { proc } of children) proc.kill("SIGKILL");
    process.exit(code);
  }, 3_000).unref();
  void Promise.all(children.map((c) => c.proc.exited)).then(() => process.exit(code));
}

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));
for (const { name, essential, proc } of children) {
  void proc.exited.then((code) => {
    if (stopping) return;
    if (!essential) {
      console.error(`[${name}] exited with code ${code}; webhooks no longer reach this machine (the sweep still catches every change)`);
      return;
    }
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
  let health: { agent?: string | null; agentOnEvent?: boolean } | null = null;
  while (!stopping && Date.now() < deadline) {
    try {
      const api = await fetch(`http://127.0.0.1:${apiPort}/api/health`, { headers: { "x-tessera-token": token }, signal: AbortSignal.timeout(2_000) });
      const page = await fetch(`http://127.0.0.1:${webPort}/`, { signal: AbortSignal.timeout(5_000) });
      if (api.ok && page.ok) {
        health = (await api.json()) as { agent?: string | null; agentOnEvent?: boolean };
        break;
      }
    } catch {
      /* not up yet */
    }
    await Bun.sleep(500);
  }
  if (!health || stopping) return;

  const agent = health.agent === "claude" ? "Claude (your key)" : health.agent === "scripted" ? "a deterministic script, not Claude" : "none configured";
  console.log(`\n  \x1b[1mReady.\x1b[0m  Open  \x1b[1m${consoleUrl}\x1b[0m`);
  if (offline) {
    console.log(`  New here? The page opens with a "Start here" checklist: load seven incidents, watch the agent work them, try to break it.`);
    console.log(`  Agent in this demo: ${agent}.${health.agent === "scripted" ? " Set ANTHROPIC_API_KEY and TESSERA_MODEL in .env to use Claude." : ""}`);
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
