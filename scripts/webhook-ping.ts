/**
 * `bun run webhook:ping`: proves a webhook endpoint is ready for Airwallex BEFORE you register it there.
 *
 *   bun run webhook:ping                                                        the local API on :4010
 *   bun run webhook:ping -- --url https://abc123.ngrok.app/api/webhooks/airwallex   through your tunnel
 *
 * It signs a harmless synthetic event the way Airwallex does (HMAC-SHA256 of `x-timestamp` + raw body, keyed by your
 * webhook secret) and checks the four things that matter: a good delivery is accepted, a redelivery is ignored, a forged
 * signature is refused, and a captured delivery replayed after five minutes is refused. The event is named
 * `tessera.ping` and carries no transfer, so it changes no payment; it only leaves one row in the dedupe table.
 *
 * Tunnel the API port (4010), not the console: the console refuses any Host that is not localhost, and Airwallex cannot
 * hold the operator token. The API authenticates this one route by signature alone.
 */
import { createHmac, randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const url = flag("--url") ?? `http://127.0.0.1:${process.env.TESSERA_API_PORT || "4010"}/api/webhooks/airwallex`;
const secret = flag("--secret") ?? process.env.AWX_WEBHOOK_SECRET ?? "";

const tty = Boolean(process.stdout.isTTY || process.env.FORCE_COLOR);
const paint = (code: string, text: string) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = (t: string) => paint("1", t);
const dim = (t: string) => paint("2", t);
const green = (t: string) => paint("32", t);
const red = (t: string) => paint("31", t);

if (!secret) {
  console.error(`${red("✗")} no webhook secret. Put the secret Airwallex shows for your endpoint in AWX_WEBHOOK_SECRET (in .env, and restart the API), or pass --secret.`);
  console.error(dim("  Until you have registered an endpoint there is no secret yet: choose any string (32+ characters) for this check, set it in .env, and replace it with Airwallex's value when you register."));
  process.exit(1);
}

const sign = (timestamp: string, body: string) => createHmac("sha256", secret).update(timestamp + body).digest("hex");
const body = JSON.stringify({ id: `evt_ping_${randomUUID()}`, name: "tessera.ping", created_at: new Date().toISOString(), data: { id: randomUUID() } });

async function post(label: string, payload: string, headers: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> | null }> {
  try {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: payload, signal: AbortSignal.timeout(15_000) });
    return { status: response.status, json: (await response.json().catch(() => null)) as Record<string, unknown> | null };
  } catch (error) {
    console.error(`${red("✗")} ${label}: could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`);
    console.error(dim("  Is the API running, is AWX_WEBHOOK_SECRET set for it, and does the tunnel point at the API port?"));
    process.exit(1);
  }
}

let failed = 0;
function expect(label: string, ok: boolean, got: string): void {
  if (!ok) failed++;
  console.log(`  ${ok ? green("✓") : red("✗")} ${label}${ok ? "" : `  ${dim(`got ${got}`)}`}`);
}

console.log(`\n${bold("Webhook check")}  ${dim(url)}\n`);
const now = String(Date.now());
const first = await post("delivery", body, { "x-timestamp": now, "x-signature": sign(now, body) });
if (first.status === 404) {
  console.error(`${red("✗")} the endpoint answered 404: the API has no webhook secret configured. Set AWX_WEBHOOK_SECRET and restart the API.`);
  process.exit(1);
}
expect("a correctly signed delivery is accepted", first.status === 200 && first.json?.duplicate === false, `${first.status} ${JSON.stringify(first.json)}`);

const again = await post("redelivery", body, { "x-timestamp": now, "x-signature": sign(now, body) });
expect("a redelivery of the same event is ignored", again.status === 200 && again.json?.duplicate === true, `${again.status} ${JSON.stringify(again.json)}`);

const forged = await post("forged", body, { "x-timestamp": now, "x-signature": "0".repeat(64) });
expect("a forged signature is refused", forged.status === 401, String(forged.status));

const old = String(Date.now() - 10 * 60_000);
const fresh = JSON.stringify({ id: `evt_ping_${randomUUID()}`, name: "tessera.ping", created_at: new Date().toISOString(), data: { id: randomUUID() } });
const replay = await post("replay", fresh, { "x-timestamp": old, "x-signature": sign(old, fresh) });
expect("a validly signed delivery ten minutes old is refused", replay.status === 401, String(replay.status));

console.log("");
if (failed > 0) {
  console.log(`${red("Not ready.")} ${failed} check(s) failed. The usual cause is a secret that differs between this command and the API process.`);
  process.exit(1);
}
console.log(`${green("Ready for Airwallex.")} In the sandbox web app: Settings > Developer > Webhooks > add this URL, subscribe to ${bold("payout.transfer.paid")}, ${bold("payout.transfer.failed")}, ${bold("payout.transfer.cancelled")}, and copy the secret it shows into AWX_WEBHOOK_SECRET.`);
