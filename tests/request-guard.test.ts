import { describe, expect, it } from "bun:test";
import { checkRequest } from "../web/lib/request-guard";

const post = (host: string | null, origin: string | null) => checkRequest({ method: "POST", host, origin });

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
    expect(checkRequest({ method: "GET", host: "attacker.example", origin: null }).ok).toBe(false);
    expect(checkRequest({ method: "GET", host: "attacker.example:3100", origin: null }).ok).toBe(false);
    expect(checkRequest({ method: "GET", host: "127.0.0.1.attacker.example", origin: null }).ok).toBe(false);
    expect(checkRequest({ method: "GET", host: null, origin: null }).ok).toBe(false);
  });

  it("allows reads from the page itself without an Origin", () => {
    expect(checkRequest({ method: "GET", host: "127.0.0.1:3100", origin: null }).ok).toBe(true);
  });
});
