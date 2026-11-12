import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createAuth } from "../src/server/auth";
import { KeyRejected, TenantHost, type Validators } from "../src/server/host";
import { HealthSchema, IncidentListSchema, WorkspaceResponseSchema } from "../src/server/wire";
import { parseMasterKey, WorkspaceStore } from "../src/server/workspaces";

const TOKEN = "console-token-for-tests";
const ORIGIN = "http://localhost:3100";
const MASTER = parseMasterKey("11".repeat(32));
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Keys that look real; the stub validator accepts them without a network. */
const AWX = { clientId: "client-id-for-ada-0001", apiKey: "airwallex-secret-api-key-ada-9f3c" };
const MODEL = { provider: "anthropic", modelId: "claude-sonnet-5-5", apiKey: "sk-ant-secret-model-key-ada-77aa" };

async function hostWorld(validators: Partial<Validators> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "tessera-host-"));
  dirs.push(dataDir);
  const auth = await createAuth({ dbPath: ":memory:", secret: "a-test-secret-that-is-long-enough-1234567890", baseURL: ORIGIN });
  const store = new WorkspaceStore(join(dataDir, "workspaces.db"), MASTER);
  const host = new TenantHost({
    auth, store, master: MASTER, token: TOKEN, dataDir,
    validators: { airwallex: async () => ({ beneficiaryId: "ben-sandbox" }), model: async () => undefined, ...validators },
  });

  const call = async (method: string, path: string, options: { cookie?: string; body?: unknown; token?: string | null } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json", origin: ORIGIN };
    if (options.token !== null) headers["x-tessera-token"] = options.token ?? TOKEN;
    if (options.cookie) headers.cookie = options.cookie;
    const response = await host.fetch(new Request(`http://127.0.0.1:4010${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) }));
    const text = await response.text();
    return { status: response.status, text, json: () => JSON.parse(text) as unknown, cookies: response.headers.getSetCookie() };
  };

  const signUp = async (name: string, email: string) => {
    const response = await call("POST", "/api/auth/sign-up/email", { body: { name, email, password: "a long passphrase for tests" } });
    expect(response.status).toBe(200);
    return response.cookies.map((c) => c.split(";")[0]).join("; ");
  };

  return { host, store, dataDir, call, signUp };
}

describe("the multi-tenant host", () => {
  it("answers nothing to someone who has not signed in, and nothing without the console's token", async () => {
    const w = await hostWorld();
    expect((await w.call("GET", "/api/obligations")).status).toBe(401);
    expect((await w.call("GET", "/api/health")).status).toBe(401);
    const ada = await w.signUp("Ada", "ada@example.com");
    expect((await w.call("GET", "/api/obligations", { cookie: ada, token: null })).status).toBe(401);
    expect((await w.call("GET", "/api/obligations", { cookie: ada, token: "wrong" })).status).toBe(401);
    expect((await w.call("GET", "/api/obligations", { cookie: ada })).status).toBe(200);
  });

  it("gives every person a workspace of their own: one person's payouts never appear in another's", async () => {
    const w = await hostWorld();
    const ada = await w.signUp("Ada", "ada@example.com");
    const bo = await w.signUp("Bo", "bo@example.com");

    const created = await w.call("POST", "/api/obligations", { cookie: ada, body: { amount: 30, note: "Northwind invoice 1043, approved by finance" } });
    expect(created.status).toBe(201);

    const adaList = IncidentListSchema.parse((await w.call("GET", "/api/obligations", { cookie: ada })).json());
    const boList = IncidentListSchema.parse((await w.call("GET", "/api/obligations", { cookie: bo })).json());
    expect(adaList.items).toHaveLength(1);
    expect(boList.items).toHaveLength(0);
    const id = adaList.items[0]!.id;
    expect((await w.call("GET", `/api/obligations/${id}`, { cookie: bo })).status).toBe(404);
    expect(w.host.size).toBe(2);
  });

  it("stamps every approval with the signed-in person, not a configured operator", async () => {
    const w = await hostWorld();
    const ada = await w.signUp("Ada", "ada@example.com");
    const health = HealthSchema.parse((await w.call("GET", "/api/health", { cookie: ada })).json());
    expect(health.operator).toBe("ada@example.com");
    expect(health.offline).toBe(true);

    const created = await w.call("POST", "/api/obligations", { cookie: ada, body: { amount: 30, note: "Northwind invoice 1043, approved by finance" } });
    const view = (await w.call("GET", `/api/obligations/${(created.json() as { id: string }).id}`, { cookie: ada })).text;
    expect(view).toContain('"approver":"ada@example.com"');
  });

  it("connects keys, goes live with a ledger file of its own, and never sends a key back", async () => {
    const w = await hostWorld();
    const ada = await w.signUp("Ada", "ada@example.com");

    const before = WorkspaceResponseSchema.parse((await w.call("GET", "/api/workspace", { cookie: ada })).json());
    expect(before).toEqual({ user: { name: "Ada", email: "ada@example.com" }, workspace: { mode: "offline", airwallex: null, model: null } });

    const connected = await w.call("POST", "/api/workspace/airwallex", { cookie: ada, body: AWX });
    expect(connected.status).toBe(200);
    const modelled = await w.call("POST", "/api/workspace/model", { cookie: ada, body: MODEL });
    expect(modelled.status).toBe(200);
    const after = WorkspaceResponseSchema.parse(modelled.json());
    expect(after.workspace.mode).toBe("live");
    expect(after.workspace.airwallex).toMatchObject({ clientIdHint: "…0001", keyHint: "…9f3c", beneficiaryId: "ben-sandbox" });
    expect(after.workspace.model).toMatchObject({ provider: "anthropic", modelId: "claude-sonnet-5-5", keyHint: "…77aa" });

    // Nothing the host answers carries a key, and the stored row holds ciphertext only.
    for (const response of [connected, modelled, await w.call("GET", "/api/workspace", { cookie: ada }), await w.call("GET", "/api/health", { cookie: ada })]) {
      for (const secret of [AWX.apiKey, AWX.clientId, MODEL.apiKey]) expect(response.text).not.toContain(secret);
    }
    const raw = new Database(join(w.dataDir, "workspaces.db")).query("SELECT * FROM workspace").all();
    for (const secret of [AWX.apiKey, AWX.clientId, MODEL.apiKey]) expect(JSON.stringify(raw)).not.toContain(secret);

    const health = HealthSchema.parse((await w.call("GET", "/api/health", { cookie: ada })).json());
    expect(health.offline).toBe(false);
    expect(health.agent).toMatchObject({ kind: "model", name: "Claude" });
    expect(readdirSync(join(w.dataDir, "workspaces")).some((f) => f.endsWith(".db"))).toBe(true);

    const removed = WorkspaceResponseSchema.parse((await w.call("POST", "/api/workspace/airwallex/remove", { cookie: ada, body: {} })).json());
    expect(removed.workspace.mode).toBe("offline");
  });

  it("refuses keys the provider rejects, with a sentence the person can act on, and stores nothing", async () => {
    const w = await hostWorld({
      airwallex: async () => {
        throw new KeyRejected("Airwallex did not accept these keys.");
      },
    });
    const ada = await w.signUp("Ada", "ada@example.com");
    const refused = await w.call("POST", "/api/workspace/airwallex", { cookie: ada, body: AWX });
    expect(refused.status).toBe(422);
    expect(refused.json()).toMatchObject({ error: "KeyRejected", message: "Airwallex did not accept these keys." });
    expect(WorkspaceResponseSchema.parse((await w.call("GET", "/api/workspace", { cookie: ada })).json()).workspace.mode).toBe("offline");

    const plain = await w.call("POST", "/api/workspace/model", { cookie: ada, body: { provider: "openai", modelId: "x", apiKey: "k", baseUrl: "http://insecure.example/v1" } });
    expect(plain.status).toBe(400);
  });
});

describe("stored keys", () => {
  it("decrypt only for the workspace and the field they were written for, and only with the right master key", () => {
    const dir = mkdtempSync(join(tmpdir(), "tessera-keys-"));
    dirs.push(dir);
    const path = join(dir, "workspaces.db");
    const store = new WorkspaceStore(path, MASTER);
    store.saveAirwallex("user-a", "a@example.com", AWX, "ben-1");
    store.saveAirwallex("user-b", "b@example.com", { clientId: "client-id-for-bo-0002", apiKey: "airwallex-secret-api-key-bo-1234" }, "ben-2");
    expect(store.secrets("user-a").airwallex).toMatchObject({ clientId: AWX.clientId, apiKey: AWX.apiKey, beneficiaryId: "ben-1" });

    // Swap A's sealed key into B's row: authenticated data binds it to A, so B's row no longer decrypts.
    const db = new Database(path);
    const a = db.query<{ awx_api_key: string }, []>("SELECT awx_api_key FROM workspace WHERE user_id = 'user-a'").get()!;
    db.query("UPDATE workspace SET awx_api_key = ? WHERE user_id = 'user-b'").run(a.awx_api_key);
    expect(() => store.secrets("user-b")).toThrow();

    // And another master key opens nothing.
    expect(() => new WorkspaceStore(path, parseMasterKey("22".repeat(32))).secrets("user-a")).toThrow();
  });

  it("refuses a master key that is not 32 bytes", () => {
    expect(() => parseMasterKey("too-short")).toThrow(/32 bytes/);
    expect(() => parseMasterKey(undefined)).toThrow(/32 bytes/);
  });
});
