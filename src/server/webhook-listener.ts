/**
 * The only Tessera surface meant to face the internet: Airwallex's webhook deliveries, on a port of their own.
 *
 * The operator API authenticates with a token the Next.js server holds, and binds 127.0.0.1. A tunnel (cloudflared,
 * ngrok) defeats the loopback bind: it connects from localhost, so everything on a tunnelled port is public. Pointing
 * the tunnel at the operator API would therefore put every operator route one leaked token away from the internet. This
 * listener answers exactly one route, `POST /api/webhooks/airwallex`, authenticated by Airwallex's signature, and
 * nothing else: no operator route, no health, no hints. Tunnel this port, never the API or the console.
 */
export const WEBHOOK_PATH = "/api/webhooks/airwallex";
/** Largest delivery the webhook route reads. A transfer event is a few KB; the route answers 413 above this. */
export const WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
/** What the listener's HTTP server accepts at all: just above the route's own cap, so the route answers 413 near it. */
export const WEBHOOK_SERVER_BODY_BYTES = 2 * WEBHOOK_MAX_BODY_BYTES;
export const DEFAULT_WEBHOOK_PORT = 4011;

const refuse = (status: number, error: string, extra: Record<string, string> = {}): Response =>
  Response.json({ error }, { status, headers: { "cache-control": "no-store", ...extra } });

/**
 * Airwallex's documented sandbox webhook source IPs
 * (https://www.airwallex.com/docs/developer-tools/webhooks/listen-for-webhook-events.md#whitelist-ip-addresses, read
 * 2026-11-03). Every real delivery seen on 2026-11-03 came from 34.142.189.194.
 */
export const AIRWALLEX_SANDBOX_IPS: readonly string[] = [
  "35.240.211.132", "35.187.239.216", "34.87.139.23", "136.110.35.143", "34.142.189.194", "35.197.128.86",
];

/**
 * TESSERA_WEBHOOK_SOURCE_IPS: blank = no source check (the signature is the authority); `airwallex-sandbox` = the list
 * above; otherwise a comma-separated list of IPs.
 */
export function parseSourceAllowlist(setting: string | undefined): ReadonlySet<string> | null {
  const value = setting?.trim();
  if (!value) return null;
  if (value === "airwallex-sandbox") return new Set(AIRWALLEX_SANDBOX_IPS);
  const ips = value.split(",").map((ip) => ip.trim()).filter((ip) => ip.length > 0);
  if (ips.length === 0) throw new Error(`TESSERA_WEBHOOK_SOURCE_IPS has no addresses (got "${setting}")`);
  return new Set(ips);
}

export interface PublicRouteOptions {
  /**
   * Defence in depth only, behind Cloudflare: the client address Cloudflare's edge writes into `cf-connecting-ip`
   * must be listed. A request without that header (not through the tunnel) is refused too. The signature check still
   * decides; this only sheds traffic that cannot be Airwallex before any work is done.
   */
  allowedSources?: ReadonlySet<string>;
}

/** Routes a public request: the webhook path and method reach `handle`, everything else is refused before it. */
export function publicWebhookRoutes(
  handle: (request: Request) => Promise<Response>,
  options: PublicRouteOptions = {},
): (request: Request) => Promise<Response> {
  return async (request) => {
    // `new URL` resolves dot segments, so `/api/webhooks/../obligations` is compared as `/api/obligations` and refused.
    const path = new URL(request.url).pathname;
    if (path !== WEBHOOK_PATH) return refuse(404, "NotFound");
    if (request.method !== "POST") return refuse(405, "MethodNotAllowed", { allow: "POST" });
    if (options.allowedSources && !options.allowedSources.has(request.headers.get("cf-connecting-ip") ?? "")) return refuse(403, "Forbidden");
    return handle(request);
  };
}

/** Binds the listener on 127.0.0.1; a tunnel on the same machine is what makes it public. */
export function startWebhookListener(options: { port: number; handle: (request: Request) => Promise<Response> } & PublicRouteOptions) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    // Airwallex expects an answer quickly; nothing legitimate on this port streams.
    idleTimeout: 30,
    maxRequestBodySize: WEBHOOK_SERVER_BODY_BYTES,
    fetch: publicWebhookRoutes(options.handle, options),
  });
}
