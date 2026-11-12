/**
 * Tessera API process.
 *
 *   default            one operator, credentials from the environment (single-main.ts): `bun run dev`, `bun run demo`
 *   TESSERA_AUTH=1     the multi-tenant host (host-main.ts): people sign in with Better Auth, and each brings their own
 *                      Airwallex sandbox and model keys (BYOK) into a workspace of their own
 */
if (process.env.TESSERA_AUTH === "1") await import("./host-main");
else await import("./single-main");
