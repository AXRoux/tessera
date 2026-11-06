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

/** Writes `KEY=value` pairs into a dotenv file (created 0600 if missing), keeping everything else. */
export function writeEnvFile(envFile: string, pairs: Record<string, string>): void {
  let text = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  for (const [key, value] of Object.entries(pairs)) text = upsertEnvLine(text, key, value);
  writeFileSync(envFile, text, { mode: 0o600 });
}

/** Why `url` cannot be a notification URL for Tessera's listener, or null if it can. */
export function notificationUrlProblem(url: string): string | null {
  const parsed = URL.canParse(url) ? new URL(url) : null;
  return !parsed || parsed.protocol !== "https:" || parsed.pathname !== WEBHOOK_PATH ? `the URL must be https and end in ${WEBHOOK_PATH} (got ${url})` : null;
}

export interface PointResult {
  action: "unchanged" | "updated" | "created";
  subscription: WebhookSubscription;
  /** The secret Airwallex signs with, when it differs from `currentSecret` (and was written to the env file). */
  newSecret: string | null;
}

/**
 * Points the subscription named by `ownId` at `url`, or creates one when there is none: events and version are fixed at
 * creation, only the URL can change. The secret survives a URL update; it is written to `envFile` only when it differs
 * from `currentSecret`, and never printed. Throws when Airwallex creates a subscription without returning its secret.
 */
export async function pointSubscription(
  client: Pick<AirwallexClient, "listWebhooks" | "updateWebhookUrl" | "createWebhook">,
  input: { url: string; ownId: string | undefined; currentSecret: string | undefined; envFile: string },
): Promise<PointResult> {
  const problem = notificationUrlProblem(input.url);
  if (problem) throw new Error(problem);
  const existing = findOwn(await client.listWebhooks(), input.ownId);
  if (existing) {
    const subscription = existing.url === input.url ? existing : await client.updateWebhookUrl(existing.id, input.url);
    const secret = subscription.secret ?? existing.secret ?? null;
    const newSecret = secret && secret !== input.currentSecret ? secret : null;
    if (newSecret) writeEnvFile(input.envFile, { AWX_WEBHOOK_SECRET: newSecret });
    return { action: existing.url === input.url ? "unchanged" : "updated", subscription, newSecret };
  }
  const created = await client.createWebhook({ url: input.url, events: SUBSCRIBED_EVENTS, version: WEBHOOK_API_VERSION, requestId: randomUUID() });
  if (!created.secret) {
    writeEnvFile(input.envFile, { AWX_WEBHOOK_ID: created.id });
    throw new Error(`created ${created.id}, but Airwallex returned no secret; copy it from Settings > Developer > Webhooks into AWX_WEBHOOK_SECRET`);
  }
  writeEnvFile(input.envFile, { AWX_WEBHOOK_ID: created.id, AWX_WEBHOOK_SECRET: created.secret });
  return { action: "created", subscription: created, newSecret: created.secret };
}

export const describeSubscription = (s: WebhookSubscription): string => `${s.id}  ${s.url}  version ${s.version}  events ${s.events.join(", ")}`;

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

  if (args.includes("--delete")) {
    const existing = findOwn(await client.listWebhooks(), ownId);
    if (!existing) {
      console.log(ownId ? `no subscription ${ownId} at Airwallex; clearing .env` : "AWX_WEBHOOK_ID is not set; nothing to delete");
    } else {
      await client.deleteWebhook(existing.id);
      console.log(`deleted ${existing.id}`);
    }
    if (ownId) writeEnvFile(envFile, { AWX_WEBHOOK_ID: "", AWX_WEBHOOK_SECRET: "" });
    process.exit(0);
  }

  const url = flag("--url");
  if (!url) {
    console.error(`usage: bun run webhook:register -- --url https://<public host>${WEBHOOK_PATH}   (or --delete)`);
    process.exit(1);
  }
  const problem = notificationUrlProblem(url);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }

  try {
    const result = await pointSubscription(client, { url, ownId, currentSecret: process.env.AWX_WEBHOOK_SECRET, envFile });
    console.log(`${result.action.padEnd(9)} ${describeSubscription(result.subscription)}`);
    if (result.action === "created") {
      console.log(`AWX_WEBHOOK_ID and AWX_WEBHOOK_SECRET written to ${envFile} (secret not shown). Restart the API so its webhook listener starts.`);
    } else if (result.newSecret) {
      console.log(`AWX_WEBHOOK_SECRET written to ${envFile} (not shown). Restart the API so it verifies with it.`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
