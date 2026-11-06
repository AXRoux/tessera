import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { WebhookRejected } from "../errors";

/**
 * The part of an Airwallex webhook Tessera acts on. The event is only a hint; the transfer is re-read from Airwallex.
 *
 * Envelope, as documented (https://www.airwallex.com/docs/developer-tools/webhooks/listen-for-webhook-events.md):
 * `{ id, name, account_id, org_id?, data, created_at, version }`. For `payout.transfer.*` events `data` IS the transfer,
 * the body of Get transfer by ID (https://www.airwallex.com/docs/developer-tools/webhooks/listen-for-webhook-events/transfers.md);
 * other products nest the resource under `data.object`. Both are read; neither is trusted beyond naming the transfer.
 */
export interface AirwallexWebhookEvent {
  id: string;
  name: string;
  /** `created_at` as ISO 8601 when it parses (Airwallex writes `+0000`, which `Date.parse` does not take), else as sent. */
  createdAt: string;
  /** Empty or absent for organisation-level events. */
  accountId: string | null;
  /** The API version the subscription was created with; it decides the shape of `data`. */
  version: string | null;
  /** Set for `payout.transfer.*` events; null for anything else. */
  transferId: string | null;
  /** The status the event body claims. Recorded, never applied: only a re-read moves the ledger. */
  claimedStatus: string | null;
}

export interface VerifyWebhookInput {
  secret: string;
  /** The `x-timestamp` header (milliseconds since the epoch). */
  timestamp: string | null | undefined;
  /** The `x-signature` header: hex HMAC-SHA256 of timestamp + raw body. */
  signature: string | null | undefined;
  /** The body exactly as received; re-serialized JSON would not verify. */
  rawBody: string;
  now?: number;
  toleranceMs?: number;
}

const DEFAULT_TOLERANCE_MS = 5 * 60_000;

const ResourceSchema = z.looseObject({ id: z.string().min(1).optional(), status: z.string().optional() });
const WebhookBodySchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  created_at: z.string().min(1),
  account_id: z.string().nullish(),
  version: z.string().nullish(),
  data: z.looseObject({ id: z.string().optional(), status: z.string().optional(), object: ResourceSchema.optional() }).nullish(),
});

/** Airwallex timestamps look like `2019-10-22T01:54:09+0000`; ISO 8601 wants `+00:00`. Null if it still does not parse. */
export function parseAirwallexTime(value: string): string | null {
  const iso = value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * Verifies an Airwallex webhook: HMAC-SHA256 keyed by the endpoint secret over `timestamp + rawBody`, compared in
 * constant time, with the timestamp inside ±5 minutes so a captured delivery cannot be replayed later. Throws
 * WebhookRejected; returns the parsed event only when every check passes.
 *
 * The window does not cost a genuine retry (observed on the sandbox 2026-11-06, an endpoint answering 503): Airwallex
 * retries in rounds. Within a round it tries three times in about three seconds with the same `x-timestamp`; the next
 * round came about 7.5 minutes later with a fresh `x-timestamp` and signature, carrying the same event id.
 *
 * Only the endpoint secret is ever used. Airwallex signs a web-app "test event" with a key it sends in the request's
 * own `client-secret-key` header (same docs page); trusting a key the request brings would let anyone sign anything,
 * so those are refused as a bad signature.
 */
export function verifyWebhook(input: VerifyWebhookInput): AirwallexWebhookEvent {
  const { secret, timestamp, signature, rawBody } = input;
  if (!timestamp || !signature) throw new WebhookRejected("missing_header", "x-timestamp and x-signature are required");
  if (secret.length === 0) throw new WebhookRejected("bad_signature", "no webhook secret is configured");

  const expected = Buffer.from(createHmac("sha256", secret).update(timestamp + rawBody).digest("hex"), "hex");
  const actual = /^[0-9a-fA-F]+$/.test(signature) ? Buffer.from(signature, "hex") : Buffer.alloc(0);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new WebhookRejected("bad_signature", "signature does not match the body");
  }

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) throw new WebhookRejected("malformed", "x-timestamp is not a number");
  const skew = Math.abs((input.now ?? Date.now()) - sentAt);
  if (skew > (input.toleranceMs ?? DEFAULT_TOLERANCE_MS)) {
    throw new WebhookRejected("stale", `timestamp is ${Math.round(skew / 1000)}s away from now`);
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    throw new WebhookRejected("malformed", "body is not JSON");
  }
  const body = WebhookBodySchema.safeParse(json);
  if (!body.success) throw new WebhookRejected("malformed", z.prettifyError(body.error));

  const { id, name, created_at: createdAt, account_id: accountId, version, data } = body.data;
  const resource = data?.object ?? data ?? null;
  const isTransfer = name.startsWith("payout.transfer.");
  return {
    id,
    name,
    createdAt: parseAirwallexTime(createdAt) ?? createdAt,
    accountId: accountId || null,
    version: version ?? null,
    transferId: isTransfer ? (resource?.id ?? null) : null,
    claimedStatus: isTransfer ? (resource?.status ?? null) : null,
  };
}

/**
 * Signs a delivery the way Airwallex does. Used by the offline simulator, `bun run webhook:ping` and the tests; the
 * API never signs anything.
 */
export function signWebhook(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret).update(timestamp + rawBody).digest("hex");
}
