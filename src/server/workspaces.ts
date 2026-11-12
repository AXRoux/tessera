/**
 * Bring-your-own-keys storage for the multi-tenant host. Each signed-in person has one workspace; its Airwallex sandbox
 * keys and its model key are stored here, encrypted, and are only ever decrypted inside the API process to build that
 * person's runtime. Nothing in this file returns a secret to a caller that renders it: views carry hints ("…a3f9").
 *
 * Encryption: AES-256-GCM, a fresh 96-bit IV per value, and a key derived per workspace with HKDF-SHA256 from the
 * master key (TESSERA_MASTER_KEY). The authenticated data names the workspace and the field, so a ciphertext copied to
 * another row, or into another column, fails to decrypt instead of quietly becoming someone else's key.
 */
import { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

export type ModelProvider = "anthropic" | "openai";

export interface AirwallexKeys {
  clientId: string;
  apiKey: string;
}

export interface ModelKeys {
  provider: ModelProvider;
  modelId: string;
  apiKey: string;
  /** OpenAI-compatible endpoints only. */
  baseUrl: string | null;
}

/** What a workspace looks like from outside the API process: never a key, only enough to recognise it. */
export interface WorkspaceView {
  mode: "offline" | "live";
  airwallex: { clientIdHint: string; keyHint: string; beneficiaryId: string; connectedAt: string } | null;
  model: { provider: ModelProvider; modelId: string; baseUrl: string | null; keyHint: string; connectedAt: string } | null;
}

/** Everything the host needs to build the runtime: decrypted, used in memory, never persisted in this form. */
export interface WorkspaceSecrets {
  airwallex: (AirwallexKeys & { beneficiaryId: string; ledgerKey: string }) | null;
  model: ModelKeys | null;
}

const hint = (value: string): string => `…${value.slice(-4)}`;

/** The master key: 32 bytes, given as 64 hex characters or base64. Anything shorter is refused, not padded. */
export function parseMasterKey(value: string | undefined): Buffer {
  const text = value?.trim() ?? "";
  const key = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, "hex") : Buffer.from(text, "base64");
  if (key.length !== 32) throw new Error("TESSERA_MASTER_KEY must be 32 bytes: 64 hex characters or base64 (generate one with `openssl rand -hex 32`)");
  return key;
}

/** A secret derived from the master key for one purpose and one workspace (HKDF-SHA256). */
export function deriveSecret(master: Buffer, purpose: string, workspaceId: string, length = 32): Buffer {
  return Buffer.from(hkdfSync("sha256", master, Buffer.from("tessera/v1"), Buffer.from(`${purpose}:${workspaceId}`), length));
}

export class WorkspaceStore {
  private readonly db: Database;

  constructor(
    path: string,
    private readonly master: Buffer,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS workspace (
      user_id TEXT PRIMARY KEY, operator TEXT,
      awx_client_id TEXT, awx_api_key TEXT, awx_client_hint TEXT, awx_key_hint TEXT, awx_beneficiary_id TEXT, awx_connected_at TEXT,
      model_provider TEXT, model_id TEXT, model_base_url TEXT, model_api_key TEXT, model_key_hint TEXT, model_connected_at TEXT
    )`);
  }

  view(userId: string): WorkspaceView {
    const row = this.row(userId);
    const airwallex = row?.awx_api_key
      ? { clientIdHint: row.awx_client_hint!, keyHint: row.awx_key_hint!, beneficiaryId: row.awx_beneficiary_id!, connectedAt: row.awx_connected_at! }
      : null;
    const model = row?.model_api_key
      ? { provider: row.model_provider as ModelProvider, modelId: row.model_id!, baseUrl: row.model_base_url, keyHint: row.model_key_hint!, connectedAt: row.model_connected_at! }
      : null;
    return { mode: airwallex ? "live" : "offline", airwallex, model };
  }

  secrets(userId: string): WorkspaceSecrets {
    const row = this.row(userId);
    if (!row) return { airwallex: null, model: null };
    const clientId = row.awx_client_id ? this.open(userId, "awx_client_id", row.awx_client_id) : null;
    const airwallex =
      clientId && row.awx_api_key
        ? {
            clientId,
            apiKey: this.open(userId, "awx_api_key", row.awx_api_key),
            beneficiaryId: row.awx_beneficiary_id!,
            // One ledger per Airwallex account: reconnecting other keys must not reconcile against this account's history.
            ledgerKey: createHash("sha256").update(`${userId}:${clientId}`).digest("hex").slice(0, 16),
          }
        : null;
    const model = row.model_api_key
      ? { provider: row.model_provider as ModelProvider, modelId: row.model_id!, baseUrl: row.model_base_url, apiKey: this.open(userId, "model_api_key", row.model_api_key) }
      : null;
    return { airwallex, model };
  }

  saveAirwallex(userId: string, operator: string, keys: AirwallexKeys, beneficiaryId: string): void {
    this.ensure(userId, operator);
    this.db
      .query(
        `UPDATE workspace SET awx_client_id = ?, awx_api_key = ?, awx_client_hint = ?, awx_key_hint = ?, awx_beneficiary_id = ?, awx_connected_at = ? WHERE user_id = ?`,
      )
      .run(
        this.seal(userId, "awx_client_id", keys.clientId),
        this.seal(userId, "awx_api_key", keys.apiKey),
        hint(keys.clientId),
        hint(keys.apiKey),
        beneficiaryId,
        this.now().toISOString(),
        userId,
      );
  }

  saveModel(userId: string, operator: string, keys: ModelKeys): void {
    this.ensure(userId, operator);
    this.db
      .query(`UPDATE workspace SET model_provider = ?, model_id = ?, model_base_url = ?, model_api_key = ?, model_key_hint = ?, model_connected_at = ? WHERE user_id = ?`)
      .run(keys.provider, keys.modelId, keys.baseUrl, this.seal(userId, "model_api_key", keys.apiKey), hint(keys.apiKey), this.now().toISOString(), userId);
  }

  clearAirwallex(userId: string): void {
    this.db
      .query(`UPDATE workspace SET awx_client_id = NULL, awx_api_key = NULL, awx_client_hint = NULL, awx_key_hint = NULL, awx_beneficiary_id = NULL, awx_connected_at = NULL WHERE user_id = ?`)
      .run(userId);
  }

  clearModel(userId: string): void {
    this.db.query(`UPDATE workspace SET model_provider = NULL, model_id = NULL, model_base_url = NULL, model_api_key = NULL, model_key_hint = NULL, model_connected_at = NULL WHERE user_id = ?`).run(userId);
  }

  /** Workspaces that are live (Airwallex connected), with who they belong to: the sweep keeps them current after a restart. */
  liveWorkspaces(): { userId: string; operator: string }[] {
    return this.db
      .query<{ user_id: string; operator: string | null }, []>(`SELECT user_id, operator FROM workspace WHERE awx_api_key IS NOT NULL`)
      .all()
      .map((r) => ({ userId: r.user_id, operator: r.operator ?? "operator" }));
  }

  close(): void {
    this.db.close();
  }

  private row(userId: string) {
    return this.db
      .query<
        {
          awx_client_id: string | null; awx_api_key: string | null; awx_client_hint: string | null; awx_key_hint: string | null; awx_beneficiary_id: string | null;
          awx_connected_at: string | null; model_provider: string | null; model_id: string | null; model_base_url: string | null; model_api_key: string | null;
          model_key_hint: string | null; model_connected_at: string | null;
        },
        [string]
      >(`SELECT * FROM workspace WHERE user_id = ?`)
      .get(userId);
  }

  private ensure(userId: string, operator: string): void {
    this.db.query(`INSERT INTO workspace (user_id, operator) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET operator = excluded.operator`).run(userId, operator);
  }

  private seal(userId: string, field: string, plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", deriveSecret(this.master, "workspace-keys", userId), iv);
    cipher.setAAD(Buffer.from(`${userId}:${field}`));
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return `v1.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64")}`;
  }

  private open(userId: string, field: string, sealed: string): string {
    if (!sealed.startsWith("v1.")) throw new Error("unrecognised key format");
    const raw = Buffer.from(sealed.slice(3), "base64");
    const decipher = createDecipheriv("aes-256-gcm", deriveSecret(this.master, "workspace-keys", userId), raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${userId}:${field}`));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  }
}
