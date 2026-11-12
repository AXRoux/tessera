/**
 * The multi-tenant host: one API process, many people, each in a workspace of their own (BYOK).
 *
 * - Who is calling is resolved from the Better Auth session cookie, here, on every request. The console forwards the
 *   cookie; it never says who someone is, so a compromised console page cannot act as another person.
 * - Each workspace is a full Tessera runtime built from that person's keys: offline (simulated Airwallex) until they
 *   connect Airwallex sandbox keys, then live, with a ledger file of its own. Its agent is their model when they bring a
 *   key, the scripted agent otherwise. Every approval in it is stamped with their email.
 * - Keys are decrypted only to build that runtime (workspaces.ts). No route returns one.
 */
import { join } from "node:path";
import { z } from "zod";
import { AirwallexClient } from "../airwallex/client";
import { AwxHttpError, SPIKE_SUPPLIER } from "../airwallex/types";
import type { Auth } from "./auth";
import { assemble, type Assembled } from "./instance";
import { buildRuntime } from "./runtime";
import { deriveSecret, type AirwallexKeys, type ModelKeys, type WorkspaceSecrets, type WorkspaceStore, type WorkspaceView } from "./workspaces";
import type { WorkspaceResponse } from "./wire";

type Env = Record<string, string | undefined>;

/** BYOK is sandbox only: a shared host never moves real money with keys a visitor typed into a form. */
export const SANDBOX_URL = "https://api.sandbox.airwallex.com";

export interface Validators {
  /** Proves the keys work and returns the beneficiary new payouts go to (created in the sandbox when missing). */
  airwallex(keys: AirwallexKeys): Promise<{ beneficiaryId: string }>;
  /** Proves the key works and that it can reach the model it names. */
  model(keys: ModelKeys): Promise<void>;
}

/** A refusal a person can act on: shown under the form that caused it. */
export class KeyRejected extends Error {}

export interface HostDeps {
  auth: Auth;
  store: WorkspaceStore;
  master: Buffer;
  token: string;
  /** Where live ledgers are written: `<dataDir>/workspaces/<user>-<account>.db`. */
  dataDir: string;
  /** Settings every workspace shares (pace, hold window). Never credentials. */
  baseEnv?: Env;
  validators?: Validators;
  /** Offline workspaces are memory; one that sits idle this long is dropped and starts fresh next time. */
  offlineIdleMs?: number;
  /** How many workspaces may be held in memory at once; the least recently used offline one is dropped first. */
  maxWorkspaces?: number;
  now?: () => number;
}

interface Tenant {
  instance: Assembled;
  live: boolean;
  operator: string;
  lastUsed: number;
}

const AirwallexBody = z.object({ clientId: z.string().trim().min(8).max(128), apiKey: z.string().trim().min(16).max(512) });
const ModelBody = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("anthropic"), modelId: z.string().trim().min(3).max(120), apiKey: z.string().trim().min(16).max(512) }),
  z.object({
    provider: z.literal("openai"),
    modelId: z.string().trim().min(1).max(200),
    apiKey: z.string().trim().min(1).max(512),
    baseUrl: z.string().trim().url().max(300).refine((u) => u.startsWith("https://"), "the endpoint must be https"),
  }),
]);

const json = (body: unknown, status = 200): Response => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const problem = (status: number, error: string, message: string): Response => json({ error, message }, status);

export class TenantHost {
  private readonly tenants = new Map<string, Tenant>();
  private readonly building = new Map<string, Promise<Tenant>>();
  private readonly validators: Validators;
  private readonly now: () => number;

  constructor(private readonly deps: HostDeps) {
    this.validators = deps.validators ?? liveValidators;
    this.now = deps.now ?? Date.now;
  }

  readonly fetch = async (request: Request): Promise<Response> => {
    // Defence in depth: the API listens on loopback, and only the console holds this token.
    if (request.headers.get("x-tessera-token") !== this.deps.token) return problem(401, "Unauthorized", "missing or invalid token");
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/auth/")) return this.deps.auth.handler(request);

    const session = await this.deps.auth.api.getSession({ headers: request.headers }).catch(() => null);
    if (!session) return problem(401, "Unauthenticated", "Sign in to continue.");
    const user = { id: session.user.id, name: session.user.name, email: session.user.email };

    try {
      if (url.pathname === "/api/workspace" && request.method === "GET") return json(this.workspace(user));
      if (url.pathname.startsWith("/api/workspace/") && request.method === "POST") return await this.manage(user, url.pathname.slice("/api/workspace/".length), request);
      const tenant = await this.tenant(user);
      return await tenant.instance.handle(request);
    } catch (error) {
      if (error instanceof KeyRejected) return problem(422, "KeyRejected", error.message);
      console.error("host request failed", error instanceof Error ? error.message : error);
      return problem(500, "WorkspaceUnavailable", "Your workspace could not be opened just now. Try again in a moment.");
    }
  };

  /** Every live workspace in memory, swept for bank-side changes; offline ones are swept too (their simulator moves). */
  async sweep(): Promise<void> {
    for (const [userId, tenant] of this.tenants) {
      try {
        await tenant.instance.sweep();
      } catch (error) {
        console.error(`sweep failed for workspace ${userId.slice(0, 8)}`, error instanceof Error ? error.message : error);
      }
    }
  }

  /** Opens every live workspace after a restart, so its transfers keep syncing before its owner visits. */
  async warm(): Promise<number> {
    let opened = 0;
    for (const { userId, operator } of this.deps.store.liveWorkspaces()) {
      await this.tenant({ id: userId, name: operator, email: operator }).then(() => opened++, (error) => console.error(`could not open workspace ${userId.slice(0, 8)}`, error instanceof Error ? error.message : error));
    }
    return opened;
  }

  /** Drops offline workspaces that sat idle; live ones stay, their ledger is on disk and the sweep needs them. */
  evictIdle(): void {
    const idle = this.deps.offlineIdleMs ?? 30 * 60_000;
    for (const [userId, tenant] of this.tenants) {
      if (!tenant.live && this.now() - tenant.lastUsed > idle) this.drop(userId);
    }
  }

  get size(): number {
    return this.tenants.size;
  }

  private workspace(user: { name: string; email: string; id: string }): WorkspaceResponse {
    const view: WorkspaceView = this.deps.store.view(user.id);
    return { user: { name: user.name, email: user.email }, workspace: view };
  }

  private async manage(user: { id: string; name: string; email: string }, action: string, request: Request): Promise<Response> {
    const body = await request.json().catch(() => null);
    switch (action) {
      case "airwallex": {
        const input = AirwallexBody.safeParse(body);
        if (!input.success) return problem(400, "BadRequest", "Paste the Client ID and the API key from your Airwallex sandbox: Settings › Developer › API keys.");
        const { beneficiaryId } = await this.validators.airwallex(input.data);
        this.deps.store.saveAirwallex(user.id, user.email, input.data, beneficiaryId);
        await this.rebuild(user);
        return json(this.workspace(user));
      }
      case "airwallex/remove":
        this.deps.store.clearAirwallex(user.id);
        await this.rebuild(user);
        return json(this.workspace(user));
      case "model": {
        const input = ModelBody.safeParse(body);
        if (!input.success) return problem(400, "BadRequest", input.error.issues[0]?.message ?? "Choose a provider, name a model and paste its key.");
        const keys: ModelKeys = { ...input.data, baseUrl: input.data.provider === "openai" ? input.data.baseUrl : null };
        await this.validators.model(keys);
        this.deps.store.saveModel(user.id, user.email, keys);
        await this.rebuild(user);
        return json(this.workspace(user));
      }
      case "model/remove":
        this.deps.store.clearModel(user.id);
        await this.rebuild(user);
        return json(this.workspace(user));
      default:
        return problem(404, "NotFound", "no such route");
    }
  }

  private async tenant(user: { id: string; name: string; email: string }): Promise<Tenant> {
    const existing = this.tenants.get(user.id);
    if (existing) {
      existing.lastUsed = this.now();
      return existing;
    }
    const pending = this.building.get(user.id);
    if (pending) return pending;
    const build = this.build(user).finally(() => this.building.delete(user.id));
    this.building.set(user.id, build);
    return build;
  }

  private async build(user: { id: string; email: string }): Promise<Tenant> {
    this.makeRoom();
    const secrets = this.deps.store.secrets(user.id);
    const env = this.envFor(user, secrets);
    const make = async (): Promise<Assembled> =>
      assemble(buildRuntime(env), {
        token: this.deps.token,
        operator: user.email,
        env,
        // Offline, "start over" builds a fresh in-memory workspace for this person only.
        reset: async () => {
          const tenant = this.tenants.get(user.id);
          if (!tenant) return;
          const previous = tenant.instance;
          tenant.instance = await make();
          previous.stop?.();
        },
      });
    const tenant: Tenant = { instance: await make(), live: secrets.airwallex !== null, operator: user.email, lastUsed: this.now() };
    this.tenants.set(user.id, tenant);
    return tenant;
  }

  private async rebuild(user: { id: string; name: string; email: string }): Promise<void> {
    const previous = this.tenants.get(user.id);
    this.tenants.delete(user.id);
    await this.tenant(user);
    // A run may still be streaming on the old instance: let it finish before its ledger closes.
    if (previous) setTimeout(() => previous.instance.stop?.(), 5 * 60_000).unref?.();
  }

  private drop(userId: string): void {
    const tenant = this.tenants.get(userId);
    this.tenants.delete(userId);
    tenant?.instance.stop?.();
  }

  private makeRoom(): void {
    const max = this.deps.maxWorkspaces ?? 200;
    while (this.tenants.size >= max) {
      const oldest = [...this.tenants].filter(([, t]) => !t.live).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!oldest) throw new Error("too many live workspaces are open on this host");
      this.drop(oldest[0]);
    }
  }

  /** The environment one workspace's runtime is built from: its own keys, its own signing secret, its own ledger. */
  private envFor(user: { id: string; email: string }, secrets: WorkspaceSecrets): Env {
    const base = this.deps.baseEnv ?? {};
    const env: Env = {
      TESSERA_API_TOKEN: this.deps.token,
      TESSERA_APPROVAL_SECRET: deriveSecret(this.deps.master, "approval", user.id).toString("hex"),
      TESSERA_OPERATOR: user.email,
      TESSERA_PACE: base.TESSERA_PACE,
      TESSERA_PAID_HOLD_MS: base.TESSERA_PAID_HOLD_MS,
      // A bank event never spends someone's model key without them pressing a button.
      TESSERA_AGENT_ON_EVENT: "0",
    };
    if (secrets.airwallex) {
      env.AWX_CLIENT_ID = secrets.airwallex.clientId;
      env.AWX_API_KEY = secrets.airwallex.apiKey;
      env.AWX_BASE_URL = SANDBOX_URL;
      env.TESSERA_BENEFICIARY_ID = secrets.airwallex.beneficiaryId;
      env.TESSERA_DB = join(this.deps.dataDir, "workspaces", `${user.id}-${secrets.airwallex.ledgerKey}.db`);
    } else {
      env.TESSERA_OFFLINE = "1";
    }
    if (secrets.model?.provider === "anthropic") {
      env.ANTHROPIC_API_KEY = secrets.model.apiKey;
      env.TESSERA_MODEL = secrets.model.modelId;
    } else if (secrets.model?.provider === "openai") {
      env.TESSERA_MODEL_PROVIDER = "openai";
      env.TESSERA_MODEL = secrets.model.modelId;
      env.TESSERA_MODEL_API_KEY = secrets.model.apiKey;
      env.TESSERA_MODEL_BASE_URL = secrets.model.baseUrl ?? undefined;
    }
    return env;
  }
}

/** The real checks: one read against Airwallex (creating the demo payee when missing) and one against the model's API. */
export const liveValidators: Validators = {
  async airwallex(keys) {
    const client = new AirwallexClient({ baseUrl: SANDBOX_URL, clientId: keys.clientId, apiKey: keys.apiKey });
    try {
      const existing = await client.listBeneficiaries();
      const found = existing.find((b) => b.nickname === SPIKE_SUPPLIER.nickname) ?? (await client.createBeneficiary(SPIKE_SUPPLIER));
      return { beneficiaryId: found.id };
    } catch (error) {
      if (error instanceof AwxHttpError && (error.status === 401 || error.status === 403)) {
        throw new KeyRejected("Airwallex did not accept these keys. Use a sandbox Client ID and API key: Settings › Developer › API keys.");
      }
      throw new KeyRejected(`Airwallex could not be reached with these keys (${error instanceof Error ? error.message.slice(0, 120) : "unknown error"}).`);
    }
  },
  async model(keys) {
    const listUrl = keys.provider === "anthropic" ? "https://api.anthropic.com/v1/models?limit=1000" : `${keys.baseUrl!.replace(/\/+$/, "")}/models`;
    const headers: Record<string, string> =
      keys.provider === "anthropic" ? { "x-api-key": keys.apiKey, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${keys.apiKey}` };
    const response = await fetch(listUrl, { headers, signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (!response) throw new KeyRejected("The model's API could not be reached. Check the endpoint and try again.");
    if (response.status === 401 || response.status === 403) throw new KeyRejected(`${keys.provider === "anthropic" ? "Anthropic" : "The endpoint"} did not accept this key.`);
    // An OpenAI-compatible endpoint without a model list cannot be checked further; the first run will say if the id is wrong.
    if (!response.ok) {
      if (keys.provider === "openai" && response.status === 404) return;
      throw new KeyRejected(`The model's API answered ${response.status}. Try again in a moment.`);
    }
    const listed = ((await response.json().catch(() => null)) as { data?: { id?: string }[] } | null)?.data?.map((m) => m.id).filter((id): id is string => typeof id === "string") ?? [];
    if (listed.length > 0 && !listed.includes(keys.modelId)) {
      throw new KeyRejected(`This key has no model named ${keys.modelId}. Available include: ${listed.slice(0, 4).join(", ")}.`);
    }
  },
};
