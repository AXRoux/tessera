/**
 * `bun run webhook:ping`: proves a webhook endpoint is ready for Airwallex BEFORE you point Airwallex at it.
 *
 *   bun run webhook:ping                                                              the local listener on :4011
 *   bun run webhook:ping -- --url https://<name>.trycloudflare.com/api/webhooks/airwallex   through your tunnel
 *
 * It signs a harmless synthetic event the way Airwallex does (HMAC-SHA256 of `x-timestamp` + raw body, keyed by your
 * webhook secret) and checks what matters: a good delivery is accepted, a redelivery is ignored, a forged signature is
 * refused, and a captured delivery replayed after five minutes is refused. The event is named `tessera.ping` and
 * carries no transfer, so it changes no payment; it only leaves one row in the dedupe table and one ledger event.
 *
 * It also checks that nothing else is reachable through the same host: the operator API's routes answer 404 and the
 * webhook path answers 405 to anything but POST. Tunnel the webhook listener's port (TESSERA_WEBHOOK_PORT, default
 * 4011), never the API's: the listener serves this one route and nothing else.
 */
import { randomUUID } from "node:crypto";
import { signWebhook } from "../src/airwallex/webhook";
import { DEFAULT_WEBHOOK_PORT, WEBHOOK_PATH } from "../src/server/webhook-listener";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const url = flag("--url") ?? `http://127.0.0.1:${process.env.TESSERA_WEBHOOK_PORT || DEFAULT_WEBHOOK_PORT}${WEBHOOK_PATH}`;
const secret = flag("--secret") ?? process.env.AWX_WEBHOOK_SECRET ?? "";

const tty = Boolean(process.stdout.isTTY || process.env.FORCE_COLOR);
const paint = (code: string, text: string) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = (t: string) => paint("1", t);
const dim = (t: string) => paint("2", t);
const green = (t: string) => paint("32", t);
const red = (t: string) => paint("31", t);

if (!URL.canParse(url) || new URL(url).pathname !== WEBHOOK_PATH) {
  console.error(`${red("✗")} the URL must end in ${WEBHOOK_PATH} (got ${url})`);
  process.exit(1);
}
if (!secret) {
  console.error(`${red("✗")} no webhook secret. \`bun run webhook:register -- --url <public URL>\` writes AWX_WEBHOOK_SECRET into .env (restart the API afterwards), or pass --secret.`);
  process.exit(1);
}

const pingBody = () => JSON.stringify({ id: `evt_ping_${randomUUID()}`, name: "tessera.ping", created_at: new Date().toISOString(), data: { id: randomUUID() } });
const signed = (timestamp: string, body: string) => ({ "x-timestamp": timestamp, "x-signature": signWebhook(secret, timestamp, body) });

async function send(label: string, target: string, init: RequestInit): Promise<{ status: number; json: Record<string, unknown> | null }> {
  try {
    const response = await fetch(target, { ...init, redirect: "manual", signal: AbortSignal.timeout(15_000) });
    return { status: response.status, json: (await response.json().catch(() => null)) as Record<string, unknown> | null };
  } catch (error) {
    console.error(`${red("✗")} ${label}: could not reach ${target}: ${error instanceof Error ? error.message : String(error)}`);
    console.error(dim("  Is the API running live with AWX_WEBHOOK_SECRET set (the listener only starts then), and does the tunnel point at TESSERA_WEBHOOK_PORT?"));
    process.exit(1);
  }
}
const post = (label: string, body: string, headers: Record<string, string>) =>
  send(label, url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

let failed = 0;
function expect(label: string, ok: boolean, got: string): void {
  if (!ok) failed++;
  console.log(`  ${ok ? green("✓") : red("✗")} ${label}${ok ? "" : `  ${dim(`got ${got}`)}`}`);
}

console.log(`\n${bold("Webhook check")}  ${dim(url)}\n`);
const body = pingBody();
const now = String(Date.now());
const first = await post("delivery", body, signed(now, body));
// Cloudflare's answers when the tunnel itself is the problem: 502, nothing listens behind it; 530, cloudflared has no
// connection to Cloudflare's edge yet (seen 2026-11-06 on a network that blocked the edge: it never came).
if (first.status === 502) {
  console.error(`${red("✗")} the tunnel answered 502: nothing is listening behind it. Start the API live with AWX_WEBHOOK_SECRET set.`);
  process.exit(1);
}
if (first.status === 530) {
  console.error(`${red("✗")} the tunnel answered 530: cloudflared is not connected to Cloudflare yet. Wait a few seconds; if its log keeps saying "Retrying connection", this network blocks Cloudflare's edge.`);
  process.exit(1);
}
expect("a correctly signed delivery is accepted", first.status === 200 && first.json?.duplicate === false, `${first.status} ${JSON.stringify(first.json)}`);

const again = await post("redelivery", body, signed(now, body));
expect("a redelivery of the same event is ignored", again.status === 200 && again.json?.duplicate === true, `${again.status} ${JSON.stringify(again.json)}`);

const forged = await post("forged", body, { "x-timestamp": now, "x-signature": "0".repeat(64) });
expect("a forged signature is refused", forged.status === 401, String(forged.status));

const old = String(Date.now() - 10 * 60_000);
const fresh = pingBody();
const replay = await post("replay", fresh, signed(old, fresh));
expect("a validly signed delivery ten minutes old is refused", replay.status === 401, String(replay.status));

const base = new URL(url).origin;
const health = await send("health", `${base}/api/health`, { method: "GET" });
expect("the operator API's health route is not reachable here (404)", health.status === 404, String(health.status));
const obligations = await send("obligations", `${base}/api/obligations`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
expect("the operator API's payment routes are not reachable here (404)", obligations.status === 404, String(obligations.status));
const get = await send("get", url, { method: "GET" });
expect("the webhook path takes POST only (405 on GET)", get.status === 405, String(get.status));

console.log("");
if (failed > 0) {
  console.log(`${red("Not ready.")} ${failed} check(s) failed. A 401 on the first check is usually a secret that differs between this command and the API process; a 200 on an API route means the tunnel points at the API port, not the listener.`);
  process.exit(1);
}
console.log(
  url.startsWith("https://")
    ? `${green("Ready for Airwallex.")} Point the subscription at it: ${bold(`bun run webhook:register -- --url ${url}`)}`
    : `${green("The listener is ready.")} Expose it with ${bold("bun run dev -- --tunnel")} and run this again with --url <tunnel>${WEBHOOK_PATH}.`,
);
