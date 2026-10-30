import type { NextRequest } from "next/server";
import { allowedHostsFromEnv, checkRequest } from "@/lib/request-guard";

/**
 * Every request, pages, assets and the API proxy alike, passes the host and origin check before anything renders.
 * Pages carry live ledger data, so a rebinding page must not even get the HTML.
 */
export function proxy(request: NextRequest): Response | undefined {
  const guard = checkRequest(
    { method: request.method, host: request.headers.get("host"), origin: request.headers.get("origin") },
    allowedHostsFromEnv(process.env),
  );
  if (guard.ok) return undefined;
  return Response.json({ error: "Forbidden", message: guard.message }, { status: 403, headers: { "cache-control": "no-store" } });
}
