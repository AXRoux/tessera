const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/;

export type GuardResult = { ok: true } | { ok: false; message: string };

/**
 * Tessera's web app has no login: whoever can reach it is the operator. So it must only answer to the machine
 * it runs on, and only to its own pages.
 *
 * - The Host header must be a loopback name. A page on another domain can be made to resolve to 127.0.0.1
 *   ("DNS rebinding"), but the browser still sends that domain as Host, so this refuses it.
 * - A browser write must carry an Origin equal to the Host it used. Requests with no Origin (curl, scripts) are
 *   not a cross-site risk, and Origin "null" is refused.
 */
export function checkRequest(input: { method: string; host: string | null; origin: string | null }): GuardResult {
  if (!input.host || !LOOPBACK_HOST.test(input.host)) {
    return { ok: false, message: "this app only answers on localhost" };
  }
  const isRead = input.method === "GET" || input.method === "HEAD";
  if (!isRead && input.origin !== null) {
    let originHost: string | null = null;
    try {
      originHost = new URL(input.origin).host;
    } catch {
      /* an unparseable Origin, including the literal "null", is refused below */
    }
    if (originHost !== input.host) return { ok: false, message: "cross-origin request refused" };
  }
  return { ok: true };
}
