/**
 * `bun run webhook:register -- --url https://<tunnel>/api/webhooks/airwallex`: points an Airwallex SANDBOX webhook
 * subscription at Tessera's public webhook listener, over the API rather than the web app.
 *
 *   first run     creates the subscription (payout.transfer.sent/paid/failed/cancelled, pinned API version) and writes
 *                 AWX_WEBHOOK_SECRET and AWX_WEBHOOK_ID into .env. The secret is never printed. Restart the API.
 *   later runs    finds that subscription (AWX_WEBHOOK_ID) and only updates its URL. The secret does not change, so a
 *                 quick tunnel's new hostname needs no restart.
 *   --delete      removes the subscription named by AWX_WEBHOOK_ID and blanks both lines in .env.
 *
 * Airwallex documents both routes: the web app (Settings > Developer > Webhooks) and the Webhooks API
 * (https://www.airwallex.com/docs/api/webhooks/webhooks/create.md, .../update.md). Events and version are fixed when a
 * subscription is created; only its URL can be updated.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { AirwallexClient, type WebhookSubscription } from "../src/airwallex/client";
import { WEBHOOK_PATH } from "../src/server/webhook-listener";

/** The transfer events Tessera reacts to. A hint for each; the transfer is always re-read. */
export const SUBSCRIBED_EVENTS = ["payout.transfer.sent", "payout.transfer.paid", "payout.transfer.failed", "payout.transfer.cancelled"];
/**
 * Pinned so the payload shape cannot change under us. 2026-08-21 is the latest version the docs list
 * (https://www.airwallex.com/docs/api/versioning.md); every version from 2024-09 names transfer events `payout.transfer.*`
 * (older ones used `payment.*`: https://www.airwallex.com/docs/payouts/older-api-versions/transfers/transfer-webhooks.md).
 */
export const WEBHOOK_API_VERSION = "2026-08-21";

/** Sets `KEY=value` in a dotenv text: replaces the first live line for the key, else appends one. Comments are kept. */
export function upsertEnvLine(text: string, key: string, value: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.startsWith(`${key}=`));
  if (at >= 0) {
    lines[at] = `${key}=${value}`;
    return lines.join("\n");
  }
  const body = text.length === 0 || text.endsWith("\n") ? text : `${text}\n`;
  return `${body}${key}=${value}\n`;
}

/** The subscription this script manages: the one named by AWX_WEBHOOK_ID, else none (it never adopts a stranger's). */
export function findOwn(subscriptions: WebhookSubscription[], id: string | undefined): WebhookSubscription | null {
  return id ? (subscriptions.find((s) => s.id === id) ?? null) : null;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const envFile = flag("--env-file") ?? ".env";
  const baseUrl = process.env.AWX_BASE_URL ?? "https://api.sandbox.airwallex.com";
  if (!baseUrl.includes("sandbox")) {
    console.error("refusing: AWX_BASE_URL is not the Airwallex sandbox");
    process.exit(1);
  }
  const client = AirwallexClient.fromEnv(process.env);
  const ownId = process.env.AWX_WEBHOOK_ID || undefined;
  const writeEnv = (pairs: Record<string, string>): void => {
    let text = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
    for (const [key, value] of Object.entries(pairs)) text = upsertEnvLine(text, key, value);
    writeFileSync(envFile, text, { mode: 0o600 });
  };
  const describe = (s: WebhookSubscription): string => `${s.id}  ${s.url}  version ${s.version}  events ${s.events.join(", ")}`;

  const existing = findOwn(await client.listWebhooks(), ownId);

  if (args.includes("--delete")) {
    if (!existing) {
      console.log(ownId ? `no subscription ${ownId} at Airwallex; clearing .env` : "AWX_WEBHOOK_ID is not set; nothing to delete");
    } else {
      await client.deleteWebhook(existing.id);
      console.log(`deleted ${existing.id}`);
    }
    if (ownId) writeEnv({ AWX_WEBHOOK_ID: "", AWX_WEBHOOK_SECRET: "" });
    process.exit(0);
  }

  const url = flag("--url");
  if (!url) {
    console.error(`usage: bun run webhook:register -- --url https://<public host>${WEBHOOK_PATH}   (or --delete)`);
    process.exit(1);
  }
  const parsed = URL.canParse(url) ? new URL(url) : null;
  if (!parsed || parsed.protocol !== "https:" || parsed.pathname !== WEBHOOK_PATH) {
    console.error(`the URL must be https and end in ${WEBHOOK_PATH} (got ${url})`);
    process.exit(1);
  }

  if (existing) {
    const updated = existing.url === url ? existing : await client.updateWebhookUrl(existing.id, url);
    console.log(`${existing.url === url ? "unchanged" : "updated"}  ${describe(updated)}`);
    // The secret survives a URL update; write it only if .env lost it, and never print it.
    const secret = updated.secret ?? existing.secret;
    if (secret && secret !== process.env.AWX_WEBHOOK_SECRET) {
      writeEnv({ AWX_WEBHOOK_SECRET: secret });
      console.log(`AWX_WEBHOOK_SECRET written to ${envFile} (not shown). Restart the API so it verifies with it.`);
    }
    process.exit(0);
  }

  const created = await client.createWebhook({ url, events: SUBSCRIBED_EVENTS, version: WEBHOOK_API_VERSION, requestId: randomUUID() });
  if (!created.secret) {
    console.error(`created ${created.id}, but Airwallex returned no secret; copy it from Settings > Developer > Webhooks into AWX_WEBHOOK_SECRET`);
    writeEnv({ AWX_WEBHOOK_ID: created.id });
    process.exit(1);
  }
  writeEnv({ AWX_WEBHOOK_ID: created.id, AWX_WEBHOOK_SECRET: created.secret });
  console.log(`created  ${describe(created)}`);
  console.log(`AWX_WEBHOOK_ID and AWX_WEBHOOK_SECRET written to ${envFile} (secret not shown). Restart the API so its webhook listener starts.`);
}
