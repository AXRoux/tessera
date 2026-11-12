import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import type { NextConfig } from "next";

// The app imports the wire contract (pure zod) from ../src/server/wire.ts, so the workspace root is the repo root.
const root = path.join(import.meta.dirname, "..");

/**
 * The API and the web server share one config: the repo root .env. Only the two values the web server needs are taken
 * from it (never the Airwallex or Anthropic keys), and anything already in the environment wins.
 */
function loadApiCredentials(): void {
  const file = path.join(root, ".env");
  if (!existsSync(file)) return;
  const env = parseEnv(readFileSync(file, "utf8"));
  if (!process.env.TESSERA_API_TOKEN && env.TESSERA_API_TOKEN) process.env.TESSERA_API_TOKEN = env.TESSERA_API_TOKEN;
  if (!process.env.TESSERA_API_URL) {
    process.env.TESSERA_API_URL = env.TESSERA_API_URL || `http://127.0.0.1:${env.TESSERA_API_PORT || "4010"}`;
  }
}
loadApiCredentials();

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  {
    key: "Content-Security-Policy",
    value: "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  },
];

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  turbopack: { root },
  // `bun run demo` serves the dev build; the framework's corner badge has no place on a stage.
  devIndicators: false,
  outputFileTracingRoot: root,
  async headers() {
    // React's dev tooling needs eval, so the strict policy applies to production builds only.
    return process.env.NODE_ENV === "production" ? [{ source: "/:path*", headers: securityHeaders }] : [];
  },
};

export default config;
