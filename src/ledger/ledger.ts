import { Database } from "bun:sqlite";
import { canonicalJson, sha256Hex } from "../canonical";
import { DuplicateLockError } from "../errors";

export type Method = "LOCAL" | "SWIFT";
/**
 * INTENT: written before the network call. LIVE: Airwallex holds a non-terminal transfer (including FAILED, which is
 * not refunded until CANCELLED). PAID: Airwallex says paid; still not final. DEAD: CANCELLED, funds returned.
 * ABANDONED: Airwallex definitively rejected the create, so no transfer exists.
 */
export type AttemptState = "INTENT" | "LIVE" | "PAID" | "DEAD" | "ABANDONED";
export type ObligationStatus = "OPEN" | "PAYING" | "PAID" | "NEEDS_ACTION" | "ESCALATED" | "CLOSED";

export interface Obligation {
  id: string;
  reference: string;
  beneficiaryId: string;
  amountMinor: number;
  currency: string;
  method: Method;
  reason: string;
  status: ObligationStatus;
  escalationReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Attempt {
  id: string;
  obligationId: string;
  seq: number;
  requestId: string;
  beneficiaryId: string;
  amountMinor: number;
  currency: string;
  method: Method;
  reason: string;
  state: AttemptState;
  transferId: string | null;
  awxStatus: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  feeMinor: number | null;
  payerPaysMinor: number | null;
  approvalNonce: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerEvent {
  seq: number;
  obligationId: string | null;
  type: string;
  payload: unknown;
  ts: string;
  prevHash: string;
  hash: string;
}

export interface NewObligation {
  id?: string;
  reference: string;
  beneficiaryId: string;
  amountMinor: number;
  currency: string;
  method: Method;
  reason: string;
}

export type NewAttempt = Pick<
  Attempt,
  "obligationId" | "seq" | "requestId" | "beneficiaryId" | "amountMinor" | "currency" | "method" | "reason" | "approvalNonce"
> & { id?: string };

export type AttemptPatch = Partial<
  Pick<
    Attempt,
    "state" | "transferId" | "awxStatus" | "failureCode" | "failureMessage" | "feeMinor" | "payerPaysMinor" | "lastError"
  >
>;

interface HashRow {
  hash: string;
}
interface JsonRow {
  json: string;
}

const GENESIS = sha256Hex("tessera-genesis");
const PATCHABLE = [
  "state", "transferId", "awxStatus", "failureCode", "failureMessage", "feeMinor", "payerPaysMinor", "lastError",
] as const;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS obligations (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL,
  beneficiaryId TEXT NOT NULL,
  amountMinor INTEGER NOT NULL CHECK (amountMinor > 0),
  currency TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('LOCAL','SWIFT')),
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  escalationReason TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  obligationId TEXT NOT NULL REFERENCES obligations(id),
  seq INTEGER NOT NULL,
  requestId TEXT NOT NULL UNIQUE,
  beneficiaryId TEXT NOT NULL,
  amountMinor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  method TEXT NOT NULL,
  reason TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('INTENT','LIVE','PAID','DEAD','ABANDONED')),
  transferId TEXT UNIQUE,
  awxStatus TEXT,
  failureCode TEXT,
  failureMessage TEXT,
  feeMinor INTEGER,
  payerPaysMinor INTEGER,
  approvalNonce TEXT NOT NULL UNIQUE,
  lastError TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  UNIQUE (obligationId, seq)
);
-- The duplicate lock: the database itself refuses a second open attempt for an obligation.
CREATE UNIQUE INDEX IF NOT EXISTS one_open_attempt
  ON attempts (obligationId) WHERE state IN ('INTENT','LIVE','PAID');
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  obligationId TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  ts TEXT NOT NULL,
  prevHash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS certificates (
  obligationId TEXT PRIMARY KEY REFERENCES obligations(id),
  hash TEXT NOT NULL,
  json TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
`;

export class Ledger {
  readonly db: Database;
  private depth = 0;

  constructor(path = ":memory:", private readonly now: () => Date = () => new Date()) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Runs `fn` in one write transaction; nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.depth++;
    try {
      return this.db.transaction(fn).immediate();
    } finally {
      this.depth--;
    }
  }

  // ---- obligations -------------------------------------------------------

  createObligation(input: NewObligation): Obligation {
    return this.tx(() => {
      const ts = this.now().toISOString();
      const id = input.id ?? crypto.randomUUID();
      this.db
        .query(
          `INSERT INTO obligations (id, reference, beneficiaryId, amountMinor, currency, method, reason, status, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)`,
        )
        .run(id, input.reference, input.beneficiaryId, input.amountMinor, input.currency, input.method, input.reason, ts, ts);
      this.append(id, "OBLIGATION_CREATED", { ...input, id });
      return this.requireObligation(id);
    });
  }

  getObligation(id: string): Obligation | null {
    return this.db.query("SELECT * FROM obligations WHERE id = ?").get(id) as Obligation | null;
  }

  requireObligation(id: string): Obligation {
    const obligation = this.getObligation(id);
    if (!obligation) throw new Error(`unknown obligation ${id}`);
    return obligation;
  }

  listObligations(): Obligation[] {
    return this.db.query("SELECT * FROM obligations ORDER BY createdAt, id").all() as Obligation[];
  }

  setObligationTerms(id: string, terms: Pick<Obligation, "beneficiaryId" | "method" | "reason">): void {
    this.db
      .query("UPDATE obligations SET beneficiaryId = ?, method = ?, reason = ?, updatedAt = ? WHERE id = ?")
      .run(terms.beneficiaryId, terms.method, terms.reason, this.now().toISOString(), id);
  }

  setObligationStatus(id: string, status: ObligationStatus, escalationReason: string | null = null): void {
    this.db
      .query("UPDATE obligations SET status = ?, escalationReason = ?, updatedAt = ? WHERE id = ?")
      .run(status, escalationReason, this.now().toISOString(), id);
  }

  escalate(id: string, reason: string): void {
    this.tx(() => {
      this.setObligationStatus(id, "ESCALATED", reason);
      this.append(id, "ESCALATED", { reason });
    });
  }

  /** Derives status from the latest attempt. CLOSED and ESCALATED are sticky: only an explicit human action clears them. */
  refreshObligationStatus(id: string): void {
    const obligation = this.requireObligation(id);
    if (obligation.status === "CLOSED" || obligation.status === "ESCALATED") return;
    const latest = this.latestAttempt(id);
    let next: ObligationStatus = "OPEN";
    if (latest?.state === "INTENT" || latest?.state === "LIVE") next = "PAYING";
    else if (latest?.state === "PAID") next = "PAID";
    else if (latest?.state === "DEAD") next = "NEEDS_ACTION";
    if (next !== obligation.status) this.setObligationStatus(id, next);
  }

  // ---- attempts ----------------------------------------------------------

  getAttempt(id: string): Attempt | null {
    return this.db.query("SELECT * FROM attempts WHERE id = ?").get(id) as Attempt | null;
  }

  requireAttempt(id: string): Attempt {
    const attempt = this.getAttempt(id);
    if (!attempt) throw new Error(`unknown attempt ${id}`);
    return attempt;
  }

  attemptsFor(obligationId: string): Attempt[] {
    return this.db.query("SELECT * FROM attempts WHERE obligationId = ? ORDER BY seq").all(obligationId) as Attempt[];
  }

  latestAttempt(obligationId: string): Attempt | null {
    return this.db
      .query("SELECT * FROM attempts WHERE obligationId = ? ORDER BY seq DESC LIMIT 1")
      .get(obligationId) as Attempt | null;
  }

  nonceUsed(nonce: string): boolean {
    return this.db.query("SELECT 1 FROM attempts WHERE approvalNonce = ?").get(nonce) !== null;
  }

  /** Attempts Airwallex holds a live or paid transfer for; the ones `sync` must keep polling. */
  syncableAttempts(obligationId?: string): Attempt[] {
    const where = obligationId ? "AND obligationId = ?" : "";
    const params = obligationId ? [obligationId] : [];
    return this.db
      .query(`SELECT * FROM attempts WHERE state IN ('LIVE','PAID') AND transferId IS NOT NULL ${where} ORDER BY createdAt`)
      .all(...params) as Attempt[];
  }

  intentAttempts(): Attempt[] {
    return this.db.query("SELECT * FROM attempts WHERE state = 'INTENT' ORDER BY createdAt").all() as Attempt[];
  }

  insertAttempt(input: NewAttempt): Attempt {
    const id = input.id ?? crypto.randomUUID();
    const ts = this.now().toISOString();
    try {
      this.db
        .query(
          `INSERT INTO attempts (id, obligationId, seq, requestId, beneficiaryId, amountMinor, currency, method, reason, state, approvalNonce, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'INTENT', ?, ?, ?)`,
        )
        .run(id, input.obligationId, input.seq, input.requestId, input.beneficiaryId, input.amountMinor, input.currency, input.method, input.reason, input.approvalNonce, ts, ts);
    } catch (error) {
      // SQLite names the columns, not the index: the partial lock index fails on "attempts.obligationId" alone.
      if (error instanceof Error && /UNIQUE constraint failed: attempts\.obligationId$/.test(error.message)) {
        throw new DuplicateLockError(input.obligationId);
      }
      throw error;
    }
    return this.requireAttempt(id);
  }

  updateAttempt(id: string, patch: AttemptPatch): Attempt {
    const keys = PATCHABLE.filter((key) => patch[key] !== undefined);
    if (keys.length > 0) {
      const assignments = keys.map((key) => `${key} = ?`).join(", ");
      const values = keys.map((key) => patch[key] as string | number | null);
      this.db
        .query(`UPDATE attempts SET ${assignments}, updatedAt = ? WHERE id = ?`)
        .run(...values, this.now().toISOString(), id);
    }
    return this.requireAttempt(id);
  }

  // ---- closure certificates ----------------------------------------------

  saveCertificate(obligationId: string, hash: string, json: string): void {
    this.db
      .query("INSERT INTO certificates (obligationId, hash, json, createdAt) VALUES (?, ?, ?, ?)")
      .run(obligationId, hash, json, this.now().toISOString());
  }

  getCertificateJson(obligationId: string): string | null {
    const row = this.db.query("SELECT json FROM certificates WHERE obligationId = ?").get(obligationId) as JsonRow | null;
    return row?.json ?? null;
  }

  // ---- event chain -------------------------------------------------------

  append(obligationId: string | null, type: string, payload: unknown): LedgerEvent {
    const last = this.db.query("SELECT hash FROM events ORDER BY seq DESC LIMIT 1").get() as HashRow | null;
    const prevHash = last?.hash ?? GENESIS;
    const ts = this.now().toISOString();
    const body = canonicalJson(payload);
    const hash = sha256Hex(`${prevHash}|${ts}|${obligationId ?? ""}|${type}|${body}`);
    const result = this.db
      .query("INSERT INTO events (obligationId, type, payload, ts, prevHash, hash) VALUES (?, ?, ?, ?, ?, ?)")
      .run(obligationId, type, body, ts, prevHash, hash);
    return { seq: Number(result.lastInsertRowid), obligationId, type, payload: JSON.parse(body), ts, prevHash, hash };
  }

  events(obligationId?: string): LedgerEvent[] {
    const rows = (
      obligationId
        ? this.db.query("SELECT * FROM events WHERE obligationId = ? ORDER BY seq").all(obligationId)
        : this.db.query("SELECT * FROM events ORDER BY seq").all()
    ) as Array<Omit<LedgerEvent, "payload"> & { payload: string }>;
    return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  }

  /** Recomputes the whole chain. `brokenAt` is the first event whose stored hash or link does not match. */
  verifyChain(): { ok: true; head: string } | { ok: false; brokenAt: number } {
    const rows = this.db.query("SELECT * FROM events ORDER BY seq").all() as Array<
      Omit<LedgerEvent, "payload"> & { payload: string }
    >;
    let prev = GENESIS;
    for (const row of rows) {
      const expected = sha256Hex(`${prev}|${row.ts}|${row.obligationId ?? ""}|${row.type}|${row.payload}`);
      if (row.prevHash !== prev || row.hash !== expected) return { ok: false, brokenAt: row.seq };
      prev = row.hash;
    }
    return { ok: true, head: prev };
  }
}
