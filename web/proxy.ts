import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";
import { allowedHostsFromEnv, checkRequest } from "@/lib/request-guard";

/** The workspace's pages: in multi-tenant mode, nobody sees one without a session. */
const PROTECTED = /^\/(dashboard|queue|incidents|workspace)(\/|$)/;

/**
 * Every request, pages, assets and the API proxy alike, passes the host and origin check before anything renders.
 * Pages carry live ledger data, so a rebinding page must not even get the HTML.
 *
 * In multi-tenant mode (TESSERA_AUTH=1) a protected page without a session cookie goes to sign-in, remembering where it
 * was headed. This is the fast path only: the cookie's presence, not its validity. The API validates the session on
 * every call, and a page whose session turned out stale is sent to sign-in by its layout.
 */
export function proxy(request: NextRequest): Response | undefined {
  const guard = checkRequest(
    { method: request.method, host: request.headers.get("host"), origin: request.headers.get("origin") },
    allowedHostsFromEnv(process.env),
  );
  if (!guard.ok) return Response.json({ error: "Forbidden", message: guard.message }, { status: 403, headers: { "cache-control": "no-store" } });

  const { pathname, search } = request.nextUrl;
  if (process.env.TESSERA_AUTH === "1") {
    if (PROTECTED.test(pathname) && !getSessionCookie(request)) {
      const signIn = new URL("/sign-in", request.url);
      signIn.searchParams.set("next", `${pathname}${search}`);
      return NextResponse.redirect(signIn);
    }
  } else if (pathname === "/sign-in" || pathname === "/sign-up" || pathname.startsWith("/workspace")) {
    // One operator, no accounts: there is nothing to sign in to.
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }
  return undefined;
}
