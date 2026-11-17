import { describe, expect, it } from "bun:test";
import { createAuth, socialFromEnv } from "../src/server/auth";

const ORIGIN = "http://localhost:3100";
const SECRET = "a-test-secret-that-is-long-enough-1234567890";

/** Asks Better Auth to start a social sign-in, the way the sign-in card does. */
async function start(auth: Awaited<ReturnType<typeof createAuth>>, provider: string) {
  const response = await auth.handler(
    new Request(`${ORIGIN}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ provider, callbackURL: "/dashboard" }),
    }),
  );
  return { status: response.status, body: (await response.json()) as { url?: string; code?: string } };
}

describe("sign in with Google and Apple", () => {
  it("turns a provider on only when both its id and its secret are set", () => {
    expect(socialFromEnv({})).toEqual({});
    expect(socialFromEnv({ GOOGLE_CLIENT_ID: "id" })).toEqual({});
    expect(socialFromEnv({ GOOGLE_CLIENT_ID: " id ", GOOGLE_CLIENT_SECRET: "secret" })).toEqual({ google: { clientId: "id", clientSecret: "secret" } });
    expect(socialFromEnv({ APPLE_CLIENT_ID: "svc", APPLE_CLIENT_SECRET: "jwt", APPLE_APP_BUNDLE_IDENTIFIER: "com.x" })).toEqual({
      apple: { clientId: "svc", clientSecret: "jwt", appBundleIdentifier: "com.x" },
    });
  });

  it("sends a person to Google's consent screen when Google is configured", async () => {
    const auth = await createAuth({ dbPath: ":memory:", secret: SECRET, baseURL: ORIGIN, social: { google: { clientId: "gid", clientSecret: "gsecret" } } });
    const { status, body } = await start(auth, "google");
    expect(status).toBe(200);
    const url = new URL(body.url ?? "");
    expect(url.host).toBe("accounts.google.com");
    expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/callback/google`);
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  it("refuses a provider that is not configured, so the card can say so", async () => {
    const auth = await createAuth({ dbPath: ":memory:", secret: SECRET, baseURL: ORIGIN });
    const { status } = await start(auth, "apple");
    expect(status).toBeGreaterThanOrEqual(400);
  });
});
