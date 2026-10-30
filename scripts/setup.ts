/**
 * `bun run setup`: gets a checkout ready for the sandbox.
 *   1. Creates .env from .env.example if there is none, and fills a blank TESSERA_APPROVAL_SECRET / TESSERA_API_TOKEN
 *      with fresh random values (existing values are never touched).
 *   2. Checks the rest of the environment and says what is missing.
 *   3. With Airwallex sandbox keys, creates the demo beneficiaries if they are missing:
 *        spike-us-supplier  US company, USD, LOCAL (ACH), ABA 021000021
 *        spike-eu-supplier  German company, EUR, SWIFT, synthetic IBAN + BIC
 * Refuses to create beneficiaries anywhere but the sandbox.
 */
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { AirwallexClient } from "../src/airwallex/client";
import { SPIKE_EU_SUPPLIER, SPIKE_SUPPLIER } from "../src/airwallex/types";

const ENV_FILE = ".env";
const GENERATED: Record<string, () => string> = {
  TESSERA_APPROVAL_SECRET: () => randomBytes(32).toString("hex"),
  TESSERA_API_TOKEN: () => randomBytes(24).toString("hex"),
};

if (!existsSync(ENV_FILE)) {
  copyFileSync(".env.example", ENV_FILE);
  console.log("created .env from .env.example");
}

// Fill blank generated values in place, keeping every other line (and comment) as written.
let text = readFileSync(ENV_FILE, "utf8");
for (const [name, generate] of Object.entries(GENERATED)) {
  const line = new RegExp(`^${name}=[ \\t]*$`, "m");
  if (line.test(text)) {
    text = text.replace(line, `${name}=${generate()}`);
    console.log(`generated ${name}`);
  } else if (!new RegExp(`^${name}=`, "m").test(text)) {
    text = `${text.replace(/\n?$/, "\n")}${name}=${generate()}\n`;
    console.log(`added ${name}`);
  }
}
writeFileSync(ENV_FILE, text);
const env = { ...parseEnv(text), ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v)) } as Record<string, string | undefined>;

const check = (name: string, ok: boolean, hint: string) => console.log(`  ${ok ? "✓" : "·"} ${name}${ok ? "" : `  ${hint}`}`);
console.log("\nenvironment");
check("TESSERA_APPROVAL_SECRET", (env.TESSERA_APPROVAL_SECRET ?? "").length >= 32, "must be at least 32 characters");
check("TESSERA_API_TOKEN", Boolean(env.TESSERA_API_TOKEN), "needed by the API and the console");
check("AWX_CLIENT_ID / AWX_API_KEY", Boolean(env.AWX_CLIENT_ID && env.AWX_API_KEY), "sandbox keys: Account > Developer > API keys (not needed for `bun run demo`)");
check("ANTHROPIC_API_KEY + TESSERA_MODEL", Boolean(env.ANTHROPIC_API_KEY && env.TESSERA_MODEL), "optional: without them the reader is off (offline: scripted agent)");
if (env.ANTHROPIC_API_KEY && !env.TESSERA_MODEL) console.log("    TESSERA_MODEL is blank: set it, e.g. TESSERA_MODEL=claude-sonnet-5-5");

if (!env.AWX_CLIENT_ID || !env.AWX_API_KEY) {
  console.log("\nno Airwallex keys: skipping beneficiaries. `bun run demo` works without them.");
  process.exit(0);
}
const baseUrl = env.AWX_BASE_URL ?? "https://api.sandbox.airwallex.com";
if (!baseUrl.includes("sandbox")) {
  console.error(`\nAWX_BASE_URL is ${baseUrl}: setup creates demo beneficiaries in the sandbox only`);
  process.exit(1);
}

const client = AirwallexClient.fromEnv(env);
const existing = await client.listBeneficiaries();
console.log("\nsandbox beneficiaries");
for (const [nickname, create] of [
  [SPIKE_SUPPLIER.nickname, () => client.createBeneficiary(SPIKE_SUPPLIER)],
  [SPIKE_EU_SUPPLIER.nickname, () => client.createEuBeneficiary(SPIKE_EU_SUPPLIER)],
] as const) {
  const found = existing.find((b) => b.nickname === nickname);
  if (found) {
    console.log(`  ✓ ${nickname} ${found.id}`);
    continue;
  }
  const created = await create();
  console.log(`  + ${nickname} ${created.id} (created)`);
}
console.log("\nready: `bun run dev` for the sandbox console, `bun run demo` for the offline one");
