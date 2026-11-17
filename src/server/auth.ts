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
  /** Sign in with Google or Apple: each is on only when its client id and secret are configured. */
  social?: SocialConfig;
}

export interface SocialConfig {
  google?: { clientId: string; clientSecret: string };
  /** Apple's client secret is a signed JWT (it expires within six months); the client id is the Services ID. */
  apple?: { clientId: string; clientSecret: string; appBundleIdentifier?: string };
}

/** The providers configured in this environment: a provider needs both its id and its secret, or it stays off. */
export function socialFromEnv(env: Record<string, string | undefined>): SocialConfig {
  const pair = (id: string, secret: string) => {
    const clientId = env[id]?.trim();
    const clientSecret = env[secret]?.trim();
    return clientId && clientSecret ? { clientId, clientSecret } : undefined;
  };
  const google = pair("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET");
  const apple = pair("APPLE_CLIENT_ID", "APPLE_CLIENT_SECRET");
  const bundle = env.APPLE_APP_BUNDLE_IDENTIFIER?.trim();
  return { ...(google ? { google } : {}), ...(apple ? { apple: bundle ? { ...apple, appBundleIdentifier: bundle } : apple } : {}) };
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
    // Apple answers with a form POST from its own origin; nothing else off-site is trusted.
    trustedOrigins: [new URL(config.baseURL).origin, ...(config.social?.apple ? ["https://appleid.apple.com"] : [])],
    emailAndPassword: {
      enabled: true,
      // Long enough that a dictionary does not get far; the console shows a strength meter on the way there.
      minPasswordLength: 10,
      maxPasswordLength: 128,
      autoSignIn: true,
    },
    // Google and Apple, when their keys are set. Better Auth checks the state and PKCE verifier on every callback.
    socialProviders: {
      ...(config.social?.google ? { google: { ...config.social.google, prompt: "select_account" as const } } : {}),
      ...(config.social?.apple ? { apple: config.social.apple } : {}),
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      // A short cookie cache: every API call resolves the person, and this keeps that off the database most of the time.
      cookieCache: { enabled: true, maxAge: 60 },
    },
    user: {
      additionalFields: {
        // When the person ticked the box on the sign-up card. Optional, so rows that predate it stay valid.
        termsAcceptedAt: { type: "string", required: false, input: true },
      },
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
