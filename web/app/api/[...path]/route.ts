import type { NextRequest } from "next/server";

/**
 * Same-origin proxy to the PayOnce API. It adds the operator token server-side, so the browser never holds it, and
 * refuses cross-origin writes so a page on another site cannot drive the operator's session.
 */
const ALLOWED = /^(health|obligations(\/[\w-]+(\/[\w/-]+)?)?)$/;

const problem = (status: number, error: string, message: string): Response =>
  Response.json({ error, message }, { status, headers: { "cache-control": "no-store" } });

async function forward(request: NextRequest, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await context.params;
  const target = path.join("/");
  if (!ALLOWED.test(target)) return problem(404, "NotFound", "no such route");

  const origin = request.headers.get("origin");
  if (request.method !== "GET" && origin !== null && origin !== request.nextUrl.origin) {
    return problem(403, "Forbidden", "cross-origin request refused");
  }

  const base = process.env.PAYONCE_API_URL;
  const token = process.env.PAYONCE_API_TOKEN;
  if (!base || !token) return problem(500, "Misconfigured", "the web server has no API credentials");

  try {
    const upstream = await fetch(`${base}/api/${target}${request.nextUrl.search}`, {
      method: request.method,
      headers: { "x-payonce-token": token, "content-type": "application/json" },
      body: request.method === "GET" ? undefined : await request.text(),
      cache: "no-store",
      signal: AbortSignal.timeout(90_000),
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store" },
    });
  } catch {
    return problem(502, "ApiUnreachable", "Cannot reach the PayOnce API. Start it with: bun run api");
  }
}

export { forward as GET, forward as POST };
