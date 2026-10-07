import type { NextRequest } from "next/server";
import { checkRequest } from "@/lib/request-guard";

/**
 * Same-origin proxy to the Tessera API. It adds the operator token server-side, so the browser never holds it.
 * It answers only to loopback hosts and refuses cross-origin writes, so no other site can drive the operator's session.
 */
const ALLOWED = /^(health|agent\/run|obligations(\/[\w-]+(\/[\w/-]+)?)?)$/;

/** An agent run streams for a minute or more; everything else answers quickly. */
const timeoutFor = (target: string): number => (target === "agent/run" ? 300_000 : 90_000);

const problem = (status: number, error: string, message: string): Response =>
  Response.json({ error, message }, { status, headers: { "cache-control": "no-store" } });

async function forward(request: NextRequest, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await context.params;
  const target = path.join("/");
  if (!ALLOWED.test(target)) return problem(404, "NotFound", "no such route");

  const guard = checkRequest({
    method: request.method,
    host: request.headers.get("host"),
    origin: request.headers.get("origin"),
  });
  if (!guard.ok) return problem(403, "Forbidden", guard.message);

  const base = process.env.TESSERA_API_URL;
  const token = process.env.TESSERA_API_TOKEN;
  if (!base || !token) return problem(500, "Misconfigured", "the web server has no API credentials");

  try {
    const upstream = await fetch(`${base}/api/${target}${request.nextUrl.search}`, {
      method: request.method,
      headers: { "x-tessera-token": token, "content-type": "application/json" },
      body: request.method === "GET" ? undefined : await request.text(),
      cache: "no-store",
      signal: AbortSignal.any([AbortSignal.timeout(timeoutFor(target)), request.signal]),
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store, no-transform",
        "x-accel-buffering": "no",
      },
    });
  } catch {
    return problem(502, "ApiUnreachable", "Cannot reach the Tessera API. Start it with: bun run api");
  }
}

export { forward as GET, forward as POST };
