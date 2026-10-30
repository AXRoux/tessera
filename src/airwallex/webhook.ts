import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { WebhookRejected } from "../errors";

/** The part of an Airwallex webhook Tessera acts on. The event is only a hint; the transfer is re-read from Airwallex. */
export interface AirwallexWebhookEvent {
  id: string;
  name: string;
  createdAt: string;
  /** Set for `payout.transfer.*` events; null for anything else. */
  transferId: string | null;
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

const WebhookBodySchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  created_at: z.string().min(1),
  data: z
    .looseObject({
      id: z.string().optional(),
      object: z.looseObject({ id: z.string() }).optional(),
    })
    .optional(),
});

/**
 * Verifies an Airwallex webhook: HMAC-SHA256 keyed by the endpoint secret over `timestamp + rawBody`, compared in
 * constant time, with the timestamp inside ±5 minutes so a captured delivery cannot be replayed later. Throws
 * WebhookRejected; returns the parsed event only when every check passes.
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

  const isTransfer = body.data.name.startsWith("payout.transfer.");
  const transferId = isTransfer ? (body.data.data?.object?.id ?? body.data.data?.id ?? null) : null;
  return { id: body.data.id, name: body.data.name, createdAt: body.data.created_at, transferId };
}
