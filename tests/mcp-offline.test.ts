import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A client that launches `bun run mcp` with no keys must get a working server: TESSERA_OFFLINE=1 runs the simulator and
// starts with the seven ACME demo incidents, instead of failing on missing secrets or serving an empty ledger.
const entry = join(import.meta.dir, "..", "src", "agent", "mcp-main.ts");
// Run from an empty directory: Bun loads a .env from the working directory, and a developer's real one must not leak into these tests.
const cwd = mkdtempSync(join(tmpdir(), "tessera-mcp-"));

/** Spawns the stdio server like an MCP client would and returns a request function. stdout must be protocol only. */
async function connect(env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, entry], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "", ...env } });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let nextId = 0;
  const request = async (method: string, params?: unknown) => {
    const id = ++nextId;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    for (;;) {
      const at = buffer.indexOf("\n");
      if (at < 0) {
        const { value, done } = await reader.read();
        if (done) throw new Error("server closed before answering");
        buffer += decoder.decode(value);
        continue;
      }
      const message = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      if (message.id === id) return message;
    }
  };
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const call = async (name: string, args: unknown = {}) => (await request("tools/call", { name, arguments: args })).result.structuredContent;
  return { request, call, close: () => child.kill() };
}

describe("mcp server with no keys", () => {
  test("offline serves ten tools over seven seeded incidents, and the code still refuses a forbidden replacement", async () => {
    const server = await connect({ TESSERA_OFFLINE: "1" });
    try {
      expect((await server.request("tools/list")).result.tools).toHaveLength(10);
      const { incidents } = (await server.call("list_incidents")).result as { incidents: { incidentId: string; reference: string }[] };
      expect(incidents.map((i) => i.reference.slice(0, 9)).sort()).toEqual(
        ["ACME-1041", "ACME-1042", "ACME-1043", "ACME-1044", "ACME-1045", "ACME-1046", "ACME-1047"],
      );
      const inFlight = incidents.find((i) => i.reference.startsWith("ACME-1041"))!;
      const refused = await server.call("replace_payment", { incidentId: inFlight.incidentId });
      expect(refused.ok).toBe(false);
      expect(JSON.stringify(refused)).toContain("AutoReplacementRefused");
    } finally {
      server.close();
    }
  }, 30_000);

  test("TESSERA_MCP_SEED=0 starts offline with an empty ledger", async () => {
    const server = await connect({ TESSERA_OFFLINE: "1", TESSERA_MCP_SEED: "0" });
    try {
      expect((await server.call("list_incidents")).result.incidents).toEqual([]);
    } finally {
      server.close();
    }
  }, 30_000);

  test("with no offline flag and no secrets it exits with the missing variable named, not a hang", async () => {
    const child = Bun.spawn([process.execPath, entry], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "" } });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).not.toBe(0);
    expect(stderr).toContain("TESSERA_APPROVAL_SECRET is not set");
  }, 30_000);
});
