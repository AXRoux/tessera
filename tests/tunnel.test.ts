import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebhookSubscription } from "../src/airwallex/client";
import { tunnelProviders, tunnelUrlFrom } from "../scripts/tunnel";
import { pointSubscription } from "../scripts/webhook-register";

describe("tunnel providers", () => {
  it("reads the public URL from each provider's real log lines and nothing else", () => {
    // Lines as printed on 2026-11-06.
    expect(tunnelUrlFrom("cloudflared", "2026-11-06T01:20:46Z INF |  https://knee-shoes-circuit-fruit.trycloudflare.com                                        |"))
      .toBe("https://knee-shoes-circuit-fruit.trycloudflare.com");
    expect(tunnelUrlFrom("cloudflared", "INF Thank you for trying Cloudflare Tunnel. ... https://www.cloudflare.com/website-terms/")).toBeNull();
    expect(tunnelUrlFrom("localhost.run", "b1120dfd2440b5.lhr.life tunneled with tls termination, https://b1120dfd2440b5.lhr.life"))
      .toBe("https://b1120dfd2440b5.lhr.life");
    expect(tunnelUrlFrom("localhost.run", "To set up and manage custom domains go to https://admin.localhost.run/")).toBeNull();
  });

  it("tries cloudflared first and falls back to localhost.run; a pin is honoured and an unknown or missing one fails closed", () => {
    expect(tunnelProviders(undefined, () => true)).toEqual(["cloudflared", "localhost.run"]);
    expect(tunnelProviders(undefined, (binary) => binary === "ssh")).toEqual(["localhost.run"]);
    expect(tunnelProviders("localhost.run", () => true)).toEqual(["localhost.run"]);
    expect(() => tunnelProviders("ngrok", () => true)).toThrow(/must be one of/);
    expect(() => tunnelProviders("cloudflared", (binary) => binary === "ssh")).toThrow(/needs cloudflared/);
  });

  it("with a source allowlist only cloudflared can deliver: localhost.run sends no client address, so it is never chosen", () => {
    expect(tunnelProviders(undefined, () => true, true)).toEqual(["cloudflared"]);
    expect(tunnelProviders(undefined, (binary) => binary === "ssh", true)).toEqual([]);
    expect(() => tunnelProviders("localhost.run", () => true, true)).toThrow(/forwards no client address/);
  });
});

describe("pointing the subscription at a tunnel", () => {
  const URL_A = "https://a.lhr.life/api/webhooks/airwallex";
  const URL_B = "https://b.lhr.life/api/webhooks/airwallex";
  const sub = (id: string, url: string, secret?: string): WebhookSubscription => ({ id, url, version: "2026-08-21", events: ["payout.transfer.paid"], ...(secret ? { secret } : {}) });

  function airwallex(subscriptions: WebhookSubscription[]) {
    const calls: string[] = [];
    return {
      calls,
      client: {
        listWebhooks: async () => subscriptions,
        updateWebhookUrl: async (id: string, url: string) => {
          calls.push(`update ${id} ${url}`);
          return sub(id, url);
        },
        createWebhook: async (input: { url: string }) => {
          calls.push(`create ${input.url}`);
          return sub("wh_new", input.url, "whsec_new");
        },
      },
    };
  }
  const envFile = () => {
    const file = join(mkdtempSync(join(tmpdir(), "tessera-env-")), ".env");
    writeFileSync(file, "AWX_CLIENT_ID=keep\nAWX_WEBHOOK_ID=wh_own\nAWX_WEBHOOK_SECRET=whsec_own\n");
    return file;
  };

  it("moves its own subscription to the new URL and keeps the secret, so the running listener needs no restart", async () => {
    const { client, calls } = airwallex([sub("wh_own", URL_A)]);
    const file = envFile();
    const result = await pointSubscription(client, { url: URL_B, ownId: "wh_own", currentSecret: "whsec_own", envFile: file });

    expect(result.action).toBe("updated");
    expect(result.newSecret).toBeNull();
    expect(calls).toEqual([`update wh_own ${URL_B}`]);
    expect(readFileSync(file, "utf8")).toContain("AWX_WEBHOOK_SECRET=whsec_own\n");
  });

  it("does not touch Airwallex when the subscription already points at the URL", async () => {
    const { client, calls } = airwallex([sub("wh_own", URL_B)]);
    const result = await pointSubscription(client, { url: URL_B, ownId: "wh_own", currentSecret: "whsec_own", envFile: envFile() });
    expect(result.action).toBe("unchanged");
    expect(calls).toEqual([]);
  });

  it("never adopts someone else's subscription: it creates its own and writes its id and secret to .env", async () => {
    const { client, calls } = airwallex([sub("wh_stranger", URL_A, "whsec_stranger")]);
    const file = envFile();
    const result = await pointSubscription(client, { url: URL_B, ownId: undefined, currentSecret: undefined, envFile: file });

    expect(result.action).toBe("created");
    expect(calls).toEqual([`create ${URL_B}`]);
    const env = readFileSync(file, "utf8");
    expect(env).toContain("AWX_WEBHOOK_ID=wh_new\n");
    expect(env).toContain("AWX_WEBHOOK_SECRET=whsec_new\n");
    expect(env).toContain("AWX_CLIENT_ID=keep\n");
  });

  it("refuses a URL that is not https on the listener's path before calling Airwallex", async () => {
    const { client, calls } = airwallex([sub("wh_own", URL_A)]);
    for (const url of ["http://a.lhr.life/api/webhooks/airwallex", "https://a.lhr.life/api/obligations"]) {
      await expect(pointSubscription(client, { url, ownId: "wh_own", currentSecret: "whsec_own", envFile: envFile() })).rejects.toThrow(/must be https/);
    }
    expect(calls).toEqual([]);
  });
});
