/**
 * Every API route the browser may reach through the same-origin proxy (`app/api/[...path]/route.ts`), which attaches the
 * operator token. Anything that does not match answers 404 before the token is ever used, so a route the console calls
 * has to be listed here: tests/proxy-routes.test.ts checks every `api(...)` call in the console against this pattern.
 *
 * Deliberately absent: `webhooks/airwallex`. Airwallex cannot hold the operator token; it talks to the API directly.
 */
export const PROXIED_ROUTE = /^(health|metrics|wallets|demo\/(seed|reset)|agent\/run|obligations(\/[\w-]+(\/[\w/-]+)?)?)$/;
