import { describe, expect, it } from "bun:test";
import { allowedHostsFromEnv, checkRequest } from "../web/lib/request-guard";

const post = (host: string | null, origin: string | null) => checkRequest({ method: "POST", host, origin });
const get = (host: string | null, allowed: string[] = []) => checkRequest({ method: "GET", host, origin: null }, allowed);

describe("localhost request guard", () => {
  it("accepts a write from the page itself, whichever loopback name the browser used", () => {
    expect(post("127.0.0.1:3100", "http://127.0.0.1:3100").ok).toBe(true);
    expect(post("localhost:3100", "http://localhost:3100").ok).toBe(true);
    expect(post("[::1]:3100", "http://[::1]:3100").ok).toBe(true);
  });

  it("accepts a script that sends no Origin", () => {
    expect(post("127.0.0.1:3100", null).ok).toBe(true);
  });

  it("refuses a write whose Origin is another site", () => {
    expect(post("127.0.0.1:3100", "https://evil.example").ok).toBe(false);
  });

  it("refuses an Origin that names a different loopback port or name", () => {
    expect(post("127.0.0.1:3100", "http://localhost:3100").ok).toBe(false);
    expect(post("127.0.0.1:3100", "http://127.0.0.1:9999").ok).toBe(false);
  });

  it("refuses the opaque Origin sent by sandboxed frames", () => {
    expect(post("127.0.0.1:3100", "null").ok).toBe(false);
  });

  it("refuses a Host that is not loopback, even on a read (DNS rebinding)", () => {
    expect(get("attacker.example").ok).toBe(false);
    expect(get("attacker.example:3100").ok).toBe(false);
    expect(get("127.0.0.1.attacker.example").ok).toBe(false);
    expect(get(null).ok).toBe(false);
  });

  it("allows reads from the page itself without an Origin", () => {
    expect(get("127.0.0.1:3100").ok).toBe(true);
  });
});

describe("public demo host allowlist", () => {
  const demo = { TESSERA_PUBLIC_DEMO: "1", TESSERA_ALLOWED_HOSTS: "tessera-demo.fly.dev, Demo.Example.com:8443" };

  it("is empty unless the public demo is switched on, whatever TESSERA_ALLOWED_HOSTS says", () => {
    expect(allowedHostsFromEnv({ TESSERA_ALLOWED_HOSTS: "tessera-demo.fly.dev" })).toEqual([]);
    expect(allowedHostsFromEnv({ TESSERA_PUBLIC_DEMO: "true", TESSERA_ALLOWED_HOSTS: "tessera-demo.fly.dev" })).toEqual([]);
    expect(get("tessera-demo.fly.dev", allowedHostsFromEnv({ TESSERA_ALLOWED_HOSTS: "tessera-demo.fly.dev" })).ok).toBe(false);
  });

  it("also opens for the signed-in multi-tenant host, where every page is behind a session", () => {
    const allowed = allowedHostsFromEnv({ TESSERA_AUTH: "1", TESSERA_ALLOWED_HOSTS: "tessera.example.com" });
    expect(get("tessera.example.com", allowed).ok).toBe(true);
    expect(get("attacker.example", allowed).ok).toBe(false);
    expect(allowedHostsFromEnv({ TESSERA_AUTH: "true", TESSERA_ALLOWED_HOSTS: "tessera.example.com" })).toEqual([]);
  });

  it("answers on a listed host, on any port when the entry names none, case-insensitively", () => {
    const allowed = allowedHostsFromEnv(demo);
    expect(get("tessera-demo.fly.dev", allowed).ok).toBe(true);
    expect(get("tessera-demo.fly.dev:3100", allowed).ok).toBe(true);
    expect(get("TESSERA-DEMO.fly.dev", allowed).ok).toBe(true);
  });

  it("holds an entry with a port to that port", () => {
    const allowed = allowedHostsFromEnv(demo);
    expect(get("demo.example.com:8443", allowed).ok).toBe(true);
    expect(get("demo.example.com", allowed).ok).toBe(false);
    expect(get("demo.example.com:3100", allowed).ok).toBe(false);
  });

  it("still refuses every other host, including look-alikes of a listed one", () => {
    const allowed = allowedHostsFromEnv(demo);
    expect(get("attacker.example", allowed).ok).toBe(false);
    expect(get("tessera-demo.fly.dev.attacker.example", allowed).ok).toBe(false);
    expect(get("evil-tessera-demo.fly.dev", allowed).ok).toBe(false);
    expect(get("fly.dev", allowed).ok).toBe(false);
  });

  it("keeps loopback working alongside the allowlist", () => {
    expect(get("127.0.0.1:3100", allowedHostsFromEnv(demo)).ok).toBe(true);
  });

  it("drops entries that are not a plain host name, so a wildcard or URL cannot open the app to everyone", () => {
    const allowed = allowedHostsFromEnv({ TESSERA_PUBLIC_DEMO: "1", TESSERA_ALLOWED_HOSTS: "*, *.fly.dev, https://x.example, a/b, ,good.example" });
    expect(allowed).toEqual(["good.example"]);
    expect(get("anything.fly.dev", allowed).ok).toBe(false);
  });

  it("refuses a cross-origin write to an allowlisted host and accepts the page's own", () => {
    const allowed = allowedHostsFromEnv(demo);
    const write = (origin: string | null) => checkRequest({ method: "POST", host: "tessera-demo.fly.dev", origin }, allowed);
    expect(write("https://tessera-demo.fly.dev").ok).toBe(true);
    expect(write("https://evil.example").ok).toBe(false);
    expect(write("null").ok).toBe(false);
  });
});
