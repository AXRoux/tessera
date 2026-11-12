/**
 * The multi-tenant API process (TESSERA_AUTH=1): Better Auth sign-in, and a workspace per person built from the keys
 * they bring. Listens on loopback only; the console in front of it is the one public surface.
 *
 * Required: TESSERA_API_TOKEN (shared with the console), TESSERA_MASTER_KEY (encrypts every stored key),
 * BETTER_AUTH_SECRET (signs sessions) and BETTER_AUTH_URL (the public origin people sign in on).
 * Data lives under TESSERA_DATA_DIR (default .data): auth.db, workspaces.db and one ledger per live workspace.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { MAX_REQUEST_BODY_BYTES } from "./api";
import { createAuth } from "./auth";
import { TenantHost } from "./host";
import { parseMasterKey, WorkspaceStore } from "./workspaces";

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set: the multi-tenant host needs it (see .env.example)`);
  return value;
};

const token = required("TESSERA_API_TOKEN");
const master = parseMasterKey(required("TESSERA_MASTER_KEY"));
const dataDir = process.env.TESSERA_DATA_DIR?.trim() || ".data";
mkdirSync(join(dataDir, "workspaces"), { recursive: true });

const auth = await createAuth({ dbPath: join(dataDir, "auth.db"), secret: required("BETTER_AUTH_SECRET"), baseURL: required("BETTER_AUTH_URL") });
const store = new WorkspaceStore(join(dataDir, "workspaces.db"), master);
const host = new TenantHost({
  auth, store, master, token, dataDir,
  baseEnv: { TESSERA_PACE: process.env.TESSERA_PACE, TESSERA_PAID_HOLD_MS: process.env.TESSERA_PAID_HOLD_MS },
});

const port = Number(process.env.TESSERA_API_PORT ?? 4010);
const server = Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 255, maxRequestBodySize: MAX_REQUEST_BODY_BYTES, fetch: host.fetch });

const warmed = await host.warm();
const sweepMs = Number(process.env.TESSERA_SWEEP_MS?.trim() || 15_000);
let sweeping = false;
if (sweepMs > 0) {
  setInterval(async () => {
    if (sweeping) return;
    sweeping = true;
    await host.sweep().finally(() => (sweeping = false));
  }, sweepMs);
}
setInterval(() => host.evictIdle(), 60_000).unref();

console.log(`tessera host  http://${server.hostname}:${server.port}  ·  multi-tenant, sign-in at ${process.env.BETTER_AUTH_URL}`);
console.log(`  data ${dataDir}  |  ${warmed} live workspace(s) reopened  |  sweep ${sweepMs > 0 ? `${sweepMs}ms` : "off"}  |  BYOK: Airwallex sandbox only`);
