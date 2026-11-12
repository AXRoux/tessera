import type { NextRequest } from "next/server";
import { allowedHostsFromEnv, checkRequest } from "@/lib/request-guard";
import { PROXIED_ROUTE } from "@/lib/proxy-routes";

/**
 * Same-origin proxy to the Tessera API. It adds the operator token server-side, so the browser never holds it.
 * proxy.ts already refuses foreign hosts and cross-origin writes for every route; this repeats the check because this
 * is the route that holds the token. Signed Airwallex webhooks go to the API directly, never through here.
 */

/** An agent run streams for a minute or more; everything else answers quickly. */
const timeoutFor = (target: string): number => (target === "agent/run" ? 300_000 : 90_000);

const problem = (status: number, error: string, message: string): Response =>
  Response.json({ error, message }, { status, headers: { "cache-control": "no-store" } });

async function forward(request: NextRequest, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await context.params;
  const target = path.join("/");
  if (!PROXIED_ROUTE.test(target)) return problem(404, "NotFound", "no such route");

  const guard = checkRequest(
    { method: request.method, host: request.headers.get("host"), origin: request.headers.get("origin") },
    allowedHostsFromEnv(process.env),
  );
  if (!guard.ok) return problem(403, "Forbidden", guard.message);

  const base = process.env.TESSERA_API_URL;
  const token = process.env.TESSERA_API_TOKEN;
  if (!base || !token) return problem(500, "Misconfigured", "the web server has no API credentials");

  // The session cookie travels to the API, which resolves who is calling (multi-tenant mode); Origin lets Better Auth
  // check the request came from this site; the visitor's address keys its rate limits.
  const headers = new Headers({ "x-tessera-token": token, "content-type": request.headers.get("content-type") ?? "application/json" });
  for (const name of ["cookie", "origin", "user-agent", "accept"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("x-forwarded-for", clientAddress(request));

  try {
    const upstream = await fetch(`${base}/api/${target}${request.nextUrl.search}`, {
      method: request.method,
      headers,
      body: request.method === "GET" ? undefined : await request.text(),
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.any([AbortSignal.timeout(timeoutFor(target)), request.signal]),
    });
    const out = new Headers({
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    });
    // Better Auth sets and clears the session with Set-Cookie: every one of them must reach the browser.
    for (const cookie of upstream.headers.getSetCookie()) out.append("set-cookie", cookie);
    const location = upstream.headers.get("location");
    if (location) out.set("location", location);
    return new Response(upstream.body, { status: upstream.status, headers: out });
  } catch {
    return problem(502, "ApiUnreachable", "Cannot reach the Tessera API. Start it with: bun run demo (offline) or bun run dev");
  }
}

/**
 * The visitor's address, for rate limits. Behind the TLS proxy it is the last entry of X-Forwarded-For (the one the
 * proxy itself wrote, which the visitor cannot forge); locally there is no proxy and it is loopback.
 */
function clientAddress(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",").map((part) => part.trim()).filter(Boolean);
  return forwarded?.at(-1) ?? "127.0.0.1";
}

export { forward as GET, forward as POST };
