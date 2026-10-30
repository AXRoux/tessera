/**
 * One command for the API and the console, with prefixed logs; stopping either stops both.
 *
 *   bun run demo   offline: simulated Airwallex, scripted agent (Claude if a key is set), a 6s hold, no keys needed
 *   bun run dev    live: the same two processes on the .env credentials
 *
 * Flags: --offline, --production (web runs `next start` on a built app), --host <address> (web bind address; the API
 * always stays on 127.0.0.1). The API token is generated when unset and handed to both processes.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const offline = args.includes("--offline");
const production = args.includes("--production");
const hostAt = args.indexOf("--host");
const webHost = hostAt >= 0 ? args[hostAt + 1] ?? "127.0.0.1" : "127.0.0.1";
const root = join(import.meta.dir, "..");
const webDir = join(root, "web");

if (!existsSync(join(webDir, "node_modules"))) {
  console.error("web dependencies are missing: run `cd web && bun install` first");
  process.exit(1);
}

const webPort = process.env.TESSERA_WEB_PORT || "3100";

/** A busy port otherwise surfaces as one child crashing and taking the other down with it, with no hint why. */
for (const [label, port] of [["API", process.env.TESSERA_API_PORT || "4010"], ["console", webPort]] as const) {
  try {
    Bun.listen({ hostname: "127.0.0.1", port: Number(port), socket: { data() {} } }).stop(true);
  } catch {
    console.error(`the ${label} port ${port} is already in use: stop what is using it, or set ${label === "API" ? "TESSERA_API_PORT" : "TESSERA_WEB_PORT"}`);
    process.exit(1);
  }
}
const apiPort = process.env.TESSERA_API_PORT || "4010";
const token = process.env.TESSERA_API_TOKEN || randomBytes(24).toString("hex");
const shared = { ...process.env, TESSERA_API_TOKEN: token, TESSERA_API_PORT: apiPort, FORCE_COLOR: "1" };
const apiEnv: Record<string, string | undefined> = offline
  ? { ...shared, TESSERA_OFFLINE: "1", TESSERA_PAID_HOLD_MS: "6000" }
  : shared;
const webEnv: Record<string, string | undefined> = { ...shared, TESSERA_API_URL: `http://127.0.0.1:${apiPort}` };

const children = [
  { name: "api", color: "34", proc: Bun.spawn([process.execPath, "run", "src/server/main.ts"], { cwd: root, env: apiEnv, stdout: "pipe", stderr: "pipe" }) },
  {
    name: "web",
    color: "35",
    proc: Bun.spawn(
      [process.execPath, "run", "next", production ? "start" : "dev", "-H", webHost, "-p", webPort],
      { cwd: webDir, env: webEnv, stdout: "pipe", stderr: "pipe" },
    ),
  },
];

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
for (const { name, proc } of children) {
  void proc.exited.then((code) => {
    if (!stopping) console.error(`[${name}] exited with code ${code}; stopping the other process`);
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
  let health: { agent?: string | null } | null = null;
  while (!stopping && Date.now() < deadline) {
    try {
      const api = await fetch(`http://127.0.0.1:${apiPort}/api/health`, { headers: { "x-tessera-token": token }, signal: AbortSignal.timeout(2_000) });
      const page = await fetch(`http://127.0.0.1:${webPort}/`, { signal: AbortSignal.timeout(5_000) });
      if (api.ok && page.ok) {
        health = (await api.json()) as { agent?: string | null };
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
    console.log(`  New here? The page opens with a "Start here" checklist: load six incidents, watch the agent work them, try to break it.`);
    console.log(`  Agent in this demo: ${agent}.${health.agent === "scripted" ? " Set ANTHROPIC_API_KEY and TESSERA_MODEL in .env to use Claude." : ""}`);
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
