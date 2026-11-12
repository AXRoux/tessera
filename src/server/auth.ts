/**
 * Sign-in for the multi-tenant host, with Better Auth: email and password, sessions in an httpOnly cookie, and the
 * account tables in a SQLite file next to the workspaces. It runs inside the API process (Bun), so the console never
 * holds a secret: it forwards /api/auth/* here, and every other API call is resolved to a person from the same cookie.
 */
import { Database } from "bun:sqlite";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { getMigrations } from "better-auth/db/migration";

export interface AuthConfig {
  /** SQLite path, or ":memory:" in tests. */
  dbPath: string;
  /** Signs session cookies and tokens: at least 32 random characters. */
  secret: string;
  /** The public origin people sign in on, e.g. https://tessera.example.com. Cookies are Secure when it is https. */
  baseURL: string;
}

export function authOptions(config: AuthConfig, database: Database) {
  // `satisfies` checks the shape against Better Auth while keeping the literal types its inference needs.
  if (config.secret.length < 32) throw new Error("BETTER_AUTH_SECRET must be at least 32 characters (generate one with `openssl rand -hex 32`)");
  return {
    appName: "Tessera",
    database,
    secret: config.secret,
    baseURL: config.baseURL,
    basePath: "/api/auth",
    trustedOrigins: [new URL(config.baseURL).origin],
    emailAndPassword: {
      enabled: true,
      // Long enough that a dictionary does not get far; the console shows a strength meter on the way there.
      minPasswordLength: 10,
      maxPasswordLength: 128,
      autoSignIn: true,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      // A short cookie cache: every API call resolves the person, and this keeps that off the database most of the time.
      cookieCache: { enabled: true, maxAge: 60 },
    },
    // Brute force on the sign-in form is the realistic attack on an open sign-up; these hold per client address.
    rateLimit: {
      enabled: true,
      window: 60,
      max: 60,
      customRules: {
        "/sign-in/email": { window: 60, max: 6 },
        "/sign-up/email": { window: 60 * 60, max: 6 },
      },
    },
    advanced: {
      // The console forwards the visitor's address (Caddy sets it); the API itself only listens on loopback.
      ipAddress: { ipAddressHeaders: ["x-forwarded-for"] },
      useSecureCookies: config.baseURL.startsWith("https://"),
    },
    telemetry: { enabled: false },
  } satisfies BetterAuthOptions;
}

export type Auth = ReturnType<typeof betterAuth<ReturnType<typeof authOptions>>>;

/** Opens the account database, brings its tables up to date, and returns the configured Better Auth instance. */
export async function createAuth(config: AuthConfig): Promise<Auth> {
  const database = new Database(config.dbPath, { create: true });
  if (config.dbPath !== ":memory:") database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  const options = authOptions(config, database);
  const { runMigrations } = await getMigrations(options);
  await runMigrations();
  return betterAuth(options);
}
