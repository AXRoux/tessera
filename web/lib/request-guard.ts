const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/;
/** A DNS name with an optional port. No userinfo, paths or wildcards: an allowlist entry names exactly one host. */
const HOST_ENTRY = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;

export type GuardResult = { ok: true } | { ok: false; message: string };

/**
 * Extra hosts the app may answer on. Only a public offline demo (TESSERA_PUBLIC_DEMO=1, which the API refuses unless
 * it runs on the simulated Airwallex) opens it beyond loopback, and then only to the names in TESSERA_ALLOWED_HOSTS.
 * An entry without a port matches that name on any port; malformed entries are dropped.
 */
export function allowedHostsFromEnv(env: Record<string, string | undefined>): string[] {
  // A public offline demo, or the signed-in multi-tenant host: the two modes that are meant to answer on a public name.
  if (env.TESSERA_PUBLIC_DEMO !== "1" && env.TESSERA_AUTH !== "1") return [];
  return (env.TESSERA_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => HOST_ENTRY.test(entry));
}

function hostAllowed(host: string, allowedHosts: readonly string[]): boolean {
  if (LOOPBACK_HOST.test(host)) return true;
  const lower = host.toLowerCase();
  const name = lower.replace(/:\d{1,5}$/, "");
  return allowedHosts.some((entry) => entry === lower || (!entry.includes(":") && entry === name));
}

/**
 * Tessera's web app has no login: whoever can reach it is the operator. So it must only answer to the machine
 * it runs on (or, for a public offline demo, to the hosts named in the allowlist), and only to its own pages.
 *
 * - The Host header must be a loopback name or an allowlisted host. A page on another domain can be made to resolve
 *   to 127.0.0.1 ("DNS rebinding"), but the browser still sends that domain as Host, so this refuses it.
 * - A browser write must carry an Origin equal to the Host it used. Requests with no Origin (curl, scripts) are
 *   not a cross-site risk, and Origin "null" is refused.
 */
export function checkRequest(
  input: { method: string; host: string | null; origin: string | null },
  allowedHosts: readonly string[] = [],
): GuardResult {
  if (!input.host || !hostAllowed(input.host, allowedHosts)) {
    return { ok: false, message: allowedHosts.length > 0 ? "this host is not on the demo's allowlist" : "this app only answers on localhost" };
  }
  const isRead = input.method === "GET" || input.method === "HEAD";
  if (!isRead && input.origin !== null) {
    let originHost: string | null = null;
    try {
      originHost = new URL(input.origin).host;
    } catch {
      /* an unparseable Origin, including the literal "null", is refused below */
    }
    if (originHost === null || originHost.toLowerCase() !== input.host.toLowerCase()) {
      return { ok: false, message: "cross-origin request refused" };
    }
  }
  return { ok: true };
}
