import { Database } from "bun:sqlite";
import { z } from "zod";
import { requireHumanNote } from "../approval/approval";
import { canonicalJson, sha256Hex } from "../canonical";
import { DuplicateConversionError, DuplicateLockError, StateConflict } from "../errors";
import { conversionMismatch, replayConversions, type ConversionAttempt, type ConversionState, type ConversionTerms } from "./conversions";
import { replayAttempts, replayObligations, replayReactions, WebhookReceivedSchema, type ReplayedAttempt } from "./events";

export type Method = "LOCAL" | "SWIFT";
/**
 * INTENT: written before the network call. LIVE: Airwallex holds a non-terminal transfer (including FAILED, which is
 * not refunded until CANCELLED, and approval states, which Airwallex lets a user resubmit). PAID: Airwallex says paid;
 * still not final. DEAD: Airwallex shows CANCELLED, funds returned. ABANDONED: no transfer exists (Airwallex definitively
 * rejected the create, or a person released an intent Airwallex has no record of); a transfer that turns up for one
 * anyway is recorded as TRANSFER_AFTER_ABANDON and escalated, never adopted.
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
  /** Airwallex's `updated_at` for the snapshot behind `awxStatus`; an older snapshot is never applied over it. */
  awxUpdatedAt: string | null;
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
    | "state" | "transferId" | "awxStatus" | "awxUpdatedAt" | "failureCode" | "failureMessage" | "feeMinor" | "payerPaysMinor"
    | "lastError"
  >
>;

/** A supplier message waiting in the inbox. Its text is untrusted: the ledger chains only its hash and length. */
export interface InboxMessage {
  id: string;
  incidentId: string;
  from: string;
  receivedAt: string;
  email: string;
  statementText?: string;
}

/** A verified Airwallex webhook delivery, as far as the ledger needs it for dedupe. */
export interface WebhookEventRecord {
  id: string;
  name: string;
  transferId: string | null;
  createdAt: string;
}

/** How a delivery was handled, chained with it as `WEBHOOK_RECEIVED`. */
export interface WebhookReceipt {
  /** The incident whose transfer the event names, when the ledger holds it. */
  obligationId: string | null;
  /** The status the event body claimed; never applied, only recorded. */
  claimedStatus: string | null;
  outcome: string;
}

/**
 * `rebaselinedAt` is set when an operator ever re-pinned the chain head (`Ledger.rebaselineChain`): the chain is
 * intact from the genesis, but the recorded head and count were accepted on a person's word at that time.
 */
export type ChainVerification =
  | { ok: true; head: string; rebaselinedAt?: string }
  | { ok: false; brokenAt: number | null; reason: string };

interface HashRow {
  hash: string;
}
interface JsonRow {
  json: string;
}
interface HeadRow {
  hash: string;
  count: number;
}
interface CertificateRow {
  obligationId: string;
  hash: string;
  json: string;
  createdAt: string;
}
interface InboxRow {
  id: string;
  incidentId: string;
  sender: string;
  receivedAt: string;
  email: string;
  statementText: string | null;
}
type EventRow = Omit<LedgerEvent, "payload"> & { payload: string };

const GENESIS = sha256Hex("tessera-genesis");
const PATCHABLE = [
  "state", "transferId", "awxStatus", "awxUpdatedAt", "failureCode", "failureMessage", "feeMinor", "payerPaysMinor", "lastError",
] as const;

const PinnedHeadSchema = z.looseObject({ body: z.looseObject({ eventChainHead: z.string() }) });
const ClosedPayloadSchema = z.looseObject({ certificateHash: z.string() });

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
  awxUpdatedAt TEXT,
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
-- The last hash and the event count, written in the same transaction as each event: deleting the tail shows.
CREATE TABLE IF NOT EXISTS chain_head (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  hash TEXT NOT NULL,
  count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS certificates (
  obligationId TEXT PRIMARY KEY REFERENCES obligations(id),
  hash TEXT NOT NULL,
  json TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS revoked_certificates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  obligationId TEXT NOT NULL REFERENCES obligations(id),
  hash TEXT NOT NULL,
  json TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  revokedAt TEXT NOT NULL,
  reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY,
  incidentId TEXT NOT NULL REFERENCES obligations(id),
  sender TEXT NOT NULL,
  receivedAt TEXT NOT NULL,
  email TEXT NOT NULL,
  statementText TEXT
);
CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  transferId TEXT,
  createdAt TEXT NOT NULL,
  receivedAt TEXT NOT NULL
);
-- One row per funding conversion, keyed to the DEAD attempt whose replacement it pays for.
CREATE TABLE IF NOT EXISTS conversions (
  id TEXT PRIMARY KEY,
  obligationId TEXT NOT NULL REFERENCES obligations(id),
  forAttemptId TEXT NOT NULL REFERENCES attempts(id),
  requestId TEXT NOT NULL UNIQUE,
  -- A quote is booked once: the sandbox reports quotes as MULTI_USE, so single use is enforced here.
  quoteId TEXT NOT NULL UNIQUE,
  currencyPair TEXT NOT NULL,
  buyCurrency TEXT NOT NULL,
  buyMinor INTEGER NOT NULL CHECK (buyMinor > 0),
  sellCurrency TEXT NOT NULL,
  sellMinor INTEGER NOT NULL CHECK (sellMinor > 0),
  rate REAL NOT NULL CHECK (rate > 0),
  quoteValidTo TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('INTENT','BOOKED','SETTLED','CANCELLED','ABANDONED')),
  conversionId TEXT UNIQUE,
  awxStatus TEXT,
  approvalNonce TEXT NOT NULL UNIQUE,
  lastError TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  CHECK (buyCurrency <> sellCurrency)
);
-- The funding lock: the database itself refuses a second conversion for the same replacement.
CREATE UNIQUE INDEX IF NOT EXISTS one_conversion_per_replacement
  ON conversions (forAttemptId) WHERE state IN ('INTENT','BOOKED','SETTLED');
`;

/** Status implied by the latest attempt, ignoring the sticky CLOSED and ESCALATED. */
export function statusFor(latest: Attempt | null): ObligationStatus {
  if (latest?.state === "INTENT" || latest?.state === "LIVE") return "PAYING";
  if (latest?.state === "PAID") return "PAID";
  if (latest?.state === "DEAD") return "NEEDS_ACTION";
  return "OPEN";
}

const toInboxMessage = (row: InboxRow): InboxMessage => ({
  id: row.id,
  incidentId: row.incidentId,
  from: row.sender,
  receivedAt: row.receivedAt,
  email: row.email,
  ...(row.statementText === null ? {} : { statementText: row.statementText }),
});

/**
 * The first way an attempt row disagrees with what its own events say, or null. Fields the intent event did not record
 * (ledgers written by older builds) are not compared.
 */
function attemptMismatch(attempt: Attempt, r: ReplayedAttempt): string | null {
  if (r.state !== attempt.state || r.transferId !== attempt.transferId || r.awxStatus !== attempt.awxStatus) {
    return `is ${attempt.state}/${attempt.awxStatus ?? "-"} in its table but ${r.state}/${r.awxStatus ?? "-"} by its events`;
  }
  const differs = (field: string, stored: unknown, expected: unknown): string | null =>
    expected !== null && stored !== expected ? `has ${field} ${String(stored)} in its table but ${String(expected)} by its intent` : null;
  const found =
    differs("obligationId", attempt.obligationId, r.obligationId) ??
    differs("seq", attempt.seq, r.seq) ??
    differs("requestId", attempt.requestId, r.requestId) ??
    differs("approvalNonce", attempt.approvalNonce, r.nonce) ??
    (r.terms
      ? differs("beneficiaryId", attempt.beneficiaryId, r.terms.beneficiaryId) ??
        differs("amountMinor", attempt.amountMinor, r.terms.amountMinor) ??
        differs("currency", attempt.currency, r.terms.currency) ??
        differs("method", attempt.method, r.terms.method) ??
        differs("reason", attempt.reason, r.terms.reason)
      : null);
  if (found) return found;
  if (r.failureCodeVerifiable && (attempt.failureCode ?? null) !== r.failureCode) {
    return `has failureCode ${attempt.failureCode ?? "none"} in its table but ${r.failureCode ?? "none"} by its events`;
  }
  return null;
}

interface WebhookRow {
  id: string;
  name: string;
  transferId: string | null;
  receivedAt: string;
}

/**
 * The dedupe table against the chain: every `WEBHOOK_RECEIVED` needs its row unchanged (deleting one would let a
 * captured delivery be processed again), and every row taken since the first `WEBHOOK_RECEIVED` needs its event (an
 * inserted row would make Tessera drop a real delivery as a duplicate). Rows from builds before the event existed
 * have no event and are left alone.
 */
function webhookRowsMismatch(events: LedgerEvent[], rows: WebhookRow[]): string | null {
  const received = new Map<string, { name: string; transferId: string | null }>();
  let since: string | null = null;
  for (const event of events) {
    if (event.type !== "WEBHOOK_RECEIVED") continue;
    const p = WebhookReceivedSchema.safeParse(event.payload);
    if (!p.success) return `webhook receipt ${event.seq} is unreadable`;
    since ??= event.ts;
    received.set(p.data.eventId, { name: p.data.name, transferId: p.data.transferId });
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const [id, chained] of received) {
    const row = byId.get(id);
    if (!row) return `webhook event ${id} is in the history but missing from the dedupe table`;
    if (row.name !== chained.name || row.transferId !== chained.transferId) return `webhook event ${id} was edited in the dedupe table`;
  }
  for (const row of rows) {
    if (since !== null && row.receivedAt >= since && !received.has(row.id)) {
      return `webhook event ${row.id} is in the dedupe table but not in the history`;
    }
  }
  return null;
}

export class Ledger {
  readonly db: Database;
  private depth = 0;

  constructor(path = ":memory:", private readonly now: () => Date = () => new Date()) {
    this.db = new Database(path, { create: true });
    // busy_timeout first: another process (API + MCP share the file) may hold the lock while this one opens.
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
    this.migrate();
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

  /**
   * Creates the schema and brings a ledger file written by an older build up to it, in ONE write transaction: the
   * `chain_head` table is created and pinned atomically, so a second process opening the same file can never see the
   * table without its pin. Idempotent; safe with several processes.
   */
  private migrate(): void {
    this.tx(() => {
      const hadChainHead = this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chain_head'").get() !== null;
      this.db.exec(SCHEMA);
      const columns = this.db.query("PRAGMA table_info(attempts)").all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === "awxUpdatedAt")) this.db.exec("ALTER TABLE attempts ADD COLUMN awxUpdatedAt TEXT");
      // A file from before chain_head existed: pin today's tail so later deletions show.
      if (!hadChainHead) {
        this.db.exec(
          `INSERT OR IGNORE INTO chain_head (id, hash, count)
           SELECT 1, hash, (SELECT COUNT(*) FROM events) FROM events ORDER BY seq DESC LIMIT 1`,
        );
      }
    });
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

  /**
   * A named person clears an escalation with a written note. Status is re-derived from the latest attempt (or CLOSED
   * again if a live certificate still stands).
   */
  resolveEscalation(obligationId: string, by: string, note: string): Obligation {
    requireHumanNote(by, note);
    return this.tx(() => {
      const obligation = this.requireObligation(obligationId);
      if (obligation.status !== "ESCALATED") throw new StateConflict(`obligation ${obligationId} is ${obligation.status}, not escalated`);
      const next = this.getCertificateJson(obligationId) ? "CLOSED" : statusFor(this.latestAttempt(obligationId));
      this.setObligationStatus(obligationId, next);
      this.append(obligationId, "ESCALATION_RESOLVED", { by, note, previousReason: obligation.escalationReason });
      return this.requireObligation(obligationId);
    });
  }

  /** Derives status from the latest attempt. CLOSED and ESCALATED are sticky: only an explicit human action clears them. */
  refreshObligationStatus(id: string): void {
    const obligation = this.requireObligation(id);
    if (obligation.status === "CLOSED" || obligation.status === "ESCALATED") return;
    const next = statusFor(this.latestAttempt(id));
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

  attemptByTransferId(transferId: string): Attempt | null {
    return this.db.query("SELECT * FROM attempts WHERE transferId = ?").get(transferId) as Attempt | null;
  }

  attemptByRequestId(requestId: string): Attempt | null {
    return this.db.query("SELECT * FROM attempts WHERE requestId = ?").get(requestId) as Attempt | null;
  }

  nonceUsed(nonce: string): boolean {
    return this.db.query("SELECT 1 FROM attempts WHERE approvalNonce = ?").get(nonce) !== null;
  }

  /**
   * Attempts whose Airwallex transfer `sync` must keep polling: live or paid ones, and a released transfer that was
   * only ever held in an approval state (older builds let a person release those; Airwallex lets such a transfer be
   * edited and resubmitted, so it can still resume and pay).
   */
  syncableAttempts(obligationId?: string): Attempt[] {
    const where = obligationId ? "AND obligationId = ?" : "";
    const params = obligationId ? [obligationId] : [];
    return this.db
      .query(
        `SELECT * FROM attempts
         WHERE (state IN ('LIVE','PAID') OR (state = 'DEAD' AND awxStatus IN ('APPROVAL_REJECTED','APPROVAL_BLOCKED','APPROVAL_RECALLED')))
           AND transferId IS NOT NULL ${where} ORDER BY createdAt`,
      )
      .all(...params) as Attempt[];
  }

  intentAttempts(obligationId?: string): Attempt[] {
    const where = obligationId ? "AND obligationId = ?" : "";
    const params = obligationId ? [obligationId] : [];
    return this.db.query(`SELECT * FROM attempts WHERE state = 'INTENT' ${where} ORDER BY createdAt`).all(...params) as Attempt[];
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

  /**
   * Compare-and-set INTENT -> ABANDONED. Null when the attempt is no longer an INTENT (another process adopted or
   * released it first), in which case nothing is written.
   */
  abandonIntent(id: string, lastError?: string): Attempt | null {
    const result = this.db
      .query("UPDATE attempts SET state = 'ABANDONED', lastError = COALESCE(?, lastError), updatedAt = ? WHERE id = ? AND state = 'INTENT'")
      .run(lastError ?? null, this.now().toISOString(), id);
    return result.changes > 0 ? this.requireAttempt(id) : null;
  }

  // ---- funding conversions -----------------------------------------------

  /** Writes a conversion INTENT. The partial unique index refuses a second open or settled one for the same replacement. */
  insertConversion(input: ConversionTerms & { obligationId: string; forAttemptId: string; requestId: string; approvalNonce: string }): ConversionAttempt {
    const id = crypto.randomUUID();
    const ts = this.now().toISOString();
    try {
      this.db
        .query(
          `INSERT INTO conversions (id, obligationId, forAttemptId, requestId, quoteId, currencyPair, buyCurrency, buyMinor, sellCurrency,
             sellMinor, rate, quoteValidTo, state, approvalNonce, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'INTENT', ?, ?, ?)`,
        )
        .run(
          id, input.obligationId, input.forAttemptId, input.requestId, input.quoteId, input.currencyPair, input.buyCurrency, input.buyMinor,
          input.sellCurrency, input.sellMinor, input.rate, input.quoteValidTo, input.approvalNonce, ts, ts,
        );
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed: conversions\.forAttemptId$/.test(error.message)) {
        throw new DuplicateConversionError(input.obligationId, input.forAttemptId);
      }
      throw error;
    }
    return this.requireConversion(id);
  }

  getConversion(id: string): ConversionAttempt | null {
    return this.db.query("SELECT * FROM conversions WHERE id = ?").get(id) as ConversionAttempt | null;
  }

  requireConversion(id: string): ConversionAttempt {
    const row = this.getConversion(id);
    if (!row) throw new Error(`unknown conversion ${id}`);
    return row;
  }

  conversionsFor(obligationId: string): ConversionAttempt[] {
    return this.db.query("SELECT * FROM conversions WHERE obligationId = ? ORDER BY createdAt, rowid").all(obligationId) as ConversionAttempt[];
  }

  conversionByAwxId(conversionId: string): ConversionAttempt | null {
    return this.db.query("SELECT * FROM conversions WHERE conversionId = ?").get(conversionId) as ConversionAttempt | null;
  }

  quoteUsed(quoteId: string): boolean {
    return this.db.query("SELECT 1 FROM conversions WHERE quoteId = ?").get(quoteId) !== null;
  }

  fundingNonceUsed(nonce: string): boolean {
    return this.db.query("SELECT 1 FROM conversions WHERE approvalNonce = ?").get(nonce) !== null;
  }

  /** Conversions in the given states, for one obligation or all, oldest first. */
  conversionsIn(states: readonly ConversionState[], obligationId?: string): ConversionAttempt[] {
    const marks = states.map(() => "?").join(", ");
    const where = obligationId ? "AND obligationId = ?" : "";
    return this.db
      .query(`SELECT * FROM conversions WHERE state IN (${marks}) ${where} ORDER BY createdAt, rowid`)
      .all(...states, ...(obligationId ? [obligationId] : [])) as ConversionAttempt[];
  }

  updateConversion(id: string, patch: Partial<Pick<ConversionAttempt, "state" | "conversionId" | "awxStatus" | "lastError">>): ConversionAttempt {
    const keys = (["state", "conversionId", "awxStatus", "lastError"] as const).filter((key) => patch[key] !== undefined);
    if (keys.length > 0) {
      this.db
        .query(`UPDATE conversions SET ${keys.map((key) => `${key} = ?`).join(", ")}, updatedAt = ? WHERE id = ?`)
        .run(...keys.map((key) => patch[key] as string | null), this.now().toISOString(), id);
    }
    return this.requireConversion(id);
  }

  /** Compare-and-set INTENT -> ABANDONED; null when another process already moved it. */
  abandonConversionIntent(id: string, reason: string): ConversionAttempt | null {
    const result = this.db
      .query("UPDATE conversions SET state = 'ABANDONED', lastError = ?, updatedAt = ? WHERE id = ? AND state = 'INTENT'")
      .run(reason, this.now().toISOString(), id);
    return result.changes > 0 ? this.requireConversion(id) : null;
  }

  // ---- closure certificates ----------------------------------------------

  saveCertificate(obligationId: string, hash: string, json: string): void {
    this.db
      .query("INSERT INTO certificates (obligationId, hash, json, createdAt) VALUES (?, ?, ?, ?)")
      .run(obligationId, hash, json, this.now().toISOString());
  }

  /** The live certificate only; a revoked one is kept in `revoked_certificates` for the record. */
  getCertificateJson(obligationId: string): string | null {
    const row = this.db.query("SELECT json FROM certificates WHERE obligationId = ?").get(obligationId) as JsonRow | null;
    return row?.json ?? null;
  }

  /**
   * Withdraws a certificate that is no longer true (a certified payment failed late). The obligation is escalated:
   * a person decides what happens next, and a fresh close is possible once it reconciles again.
   */
  revokeCertificate(obligationId: string, reason: string): void {
    this.tx(() => {
      const row = this.db.query("SELECT * FROM certificates WHERE obligationId = ?").get(obligationId) as CertificateRow | null;
      if (!row) throw new StateConflict(`obligation ${obligationId} has no certificate to revoke`);
      this.db
        .query(
          `INSERT INTO revoked_certificates (obligationId, hash, json, createdAt, revokedAt, reason)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(row.obligationId, row.hash, row.json, row.createdAt, this.now().toISOString(), reason);
      this.db.query("DELETE FROM certificates WHERE obligationId = ?").run(obligationId);
      this.append(obligationId, "CERTIFICATE_REVOKED", { certificateHash: row.hash, reason });
      this.escalate(obligationId, reason);
    });
  }

  // ---- supplier inbox ----------------------------------------------------

  /** Files a supplier message. The chain records who sent it, its hash and its length; never the text itself. */
  addInboxMessage(input: Omit<InboxMessage, "id" | "receivedAt"> & { receivedAt?: string }): InboxMessage {
    return this.tx(() => {
      this.requireObligation(input.incidentId);
      const message: InboxMessage = {
        id: crypto.randomUUID(),
        incidentId: input.incidentId,
        from: input.from,
        receivedAt: input.receivedAt ?? this.now().toISOString(),
        email: input.email,
        ...(input.statementText === undefined ? {} : { statementText: input.statementText }),
      };
      this.db
        .query("INSERT INTO inbox (id, incidentId, sender, receivedAt, email, statementText) VALUES (?, ?, ?, ?, ?, ?)")
        .run(message.id, message.incidentId, message.from, message.receivedAt, message.email, message.statementText ?? null);
      this.append(message.incidentId, "INBOX_RECEIVED", {
        messageId: message.id,
        from: message.from,
        sha256: sha256Hex(canonicalJson({ email: message.email, statementText: message.statementText ?? null })),
        chars: message.email.length + (message.statementText?.length ?? 0),
      });
      return message;
    });
  }

  /** Oldest first; messages filed in the same millisecond keep the order they were filed in. */
  inboxMessages(incidentId?: string): InboxMessage[] {
    const rows = (
      incidentId
        ? this.db.query("SELECT * FROM inbox WHERE incidentId = ? ORDER BY receivedAt, rowid").all(incidentId)
        : this.db.query("SELECT * FROM inbox ORDER BY receivedAt, rowid").all()
    ) as InboxRow[];
    return rows.map(toInboxMessage);
  }

  // ---- webhooks ----------------------------------------------------------

  /**
   * Records a verified webhook delivery by its event id: the dedupe row and a `WEBHOOK_RECEIVED` event, in one
   * transaction, so the chain proves which deliveries were taken (deleting a row to let a delivery replay breaks
   * `verifyChain`). True the first time the id is seen; Airwallex redelivers, and a redelivery writes nothing.
   */
  recordWebhookEvent(event: WebhookEventRecord, receipt: WebhookReceipt = { obligationId: null, claimedStatus: null, outcome: "recorded" }): boolean {
    return this.tx(() => {
      const result = this.db
        .query("INSERT OR IGNORE INTO webhook_events (id, name, transferId, createdAt, receivedAt) VALUES (?, ?, ?, ?, ?)")
        .run(event.id, event.name, event.transferId, event.createdAt, this.now().toISOString());
      if (result.changes === 0) return false;
      this.append(receipt.obligationId, "WEBHOOK_RECEIVED", {
        eventId: event.id, name: event.name, transferId: event.transferId, createdAt: event.createdAt,
        claimedStatus: receipt.claimedStatus, outcome: receipt.outcome,
      });
      return true;
    });
  }

  /** The latest-created delivery already taken for a transfer, to tell an out-of-order one apart. */
  latestWebhookFor(transferId: string): { id: string; name: string; createdAt: string } | null {
    return this.db
      .query("SELECT id, name, createdAt FROM webhook_events WHERE transferId = ? ORDER BY createdAt DESC LIMIT 1")
      .get(transferId) as { id: string; name: string; createdAt: string } | null;
  }

  /** Events of the given types written at or after `sinceIso`, in chain order. */
  recentEvents(types: string[], sinceIso: string): LedgerEvent[] {
    if (types.length === 0) return [];
    const rows = this.db
      .query(`SELECT * FROM events WHERE type IN (${types.map(() => "?").join(", ")}) AND ts >= ? ORDER BY seq`)
      .all(...types, sinceIso) as EventRow[];
    return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  }

  /** Whether this delivery was already handled. Recorded only after its sync succeeded, so a failed one is retried. */
  webhookEventSeen(id: string): boolean {
    return this.db.query("SELECT 1 FROM webhook_events WHERE id = ?").get(id) !== null;
  }

  // ---- event chain -------------------------------------------------------

  /** Appends one event. Reading the last hash and inserting happen in one write transaction, so processes sharing the file cannot fork the chain. */
  append(obligationId: string | null, type: string, payload: unknown): LedgerEvent {
    return this.tx(() => {
      const last = this.db.query("SELECT hash FROM events ORDER BY seq DESC LIMIT 1").get() as HashRow | null;
      const prevHash = last?.hash ?? GENESIS;
      const ts = this.now().toISOString();
      const body = canonicalJson(payload);
      const hash = sha256Hex(`${prevHash}|${ts}|${obligationId ?? ""}|${type}|${body}`);
      const result = this.db
        .query("INSERT INTO events (obligationId, type, payload, ts, prevHash, hash) VALUES (?, ?, ?, ?, ?, ?)")
        .run(obligationId, type, body, ts, prevHash, hash);
      this.db
        .query("INSERT INTO chain_head (id, hash, count) VALUES (1, ?, 1) ON CONFLICT (id) DO UPDATE SET hash = excluded.hash, count = count + 1")
        .run(hash);
      return { seq: Number(result.lastInsertRowid), obligationId, type, payload: JSON.parse(body), ts, prevHash, hash };
    });
  }

  events(obligationId?: string): LedgerEvent[] {
    const rows = (
      obligationId
        ? this.db.query("SELECT * FROM events WHERE obligationId = ? ORDER BY seq").all(obligationId)
        : this.db.query("SELECT * FROM events ORDER BY seq").all()
    ) as EventRow[];
    return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  }

  /**
   * Recomputes the whole chain and checks the tables against it: every event links and hashes, nothing was cut off
   * the tail, every certificate pins a head that is in the chain, and every attempt and obligation row matches a
   * replay of its own events (no row missing, none edited). `brokenAt` is the first bad event when there is one;
   * `reason` always says what failed.
   *
   * Reads one consistent snapshot: a second process may append while this runs, and a WAL read transaction keeps
   * the statements below from seeing half of that write.
   */
  verifyChain(): ChainVerification {
    if (this.depth > 0) return this.verifySnapshot();
    this.depth++;
    try {
      return this.db.transaction(() => this.verifySnapshot()).deferred();
    } finally {
      this.depth--;
    }
  }

  /** Links and hashes only: the part of verification that does not depend on any table. */
  private checkLinks(rows: EventRow[]): { ok: true; head: string; hashes: Set<string> } | { ok: false; brokenAt: number; reason: string } {
    const hashes = new Set<string>();
    let prev = GENESIS;
    for (const row of rows) {
      if (row.prevHash !== prev) return { ok: false, brokenAt: row.seq, reason: `event ${row.seq} does not link to the event before it` };
      const expected = sha256Hex(`${prev}|${row.ts}|${row.obligationId ?? ""}|${row.type}|${row.payload}`);
      if (row.hash !== expected) return { ok: false, brokenAt: row.seq, reason: `event ${row.seq} was altered` };
      hashes.add(row.hash);
      prev = row.hash;
    }
    return { ok: true, head: prev, hashes };
  }

  private verifySnapshot(): ChainVerification {
    const rows = this.db.query("SELECT * FROM events ORDER BY seq").all() as EventRow[];
    const links = this.checkLinks(rows);
    if (!links.ok) return links;
    const { head: prev, hashes } = links;

    const head = this.db.query("SELECT hash, count FROM chain_head WHERE id = 1").get() as HeadRow | null;
    if (head === null && rows.length > 0) return { ok: false, brokenAt: null, reason: "the chain head record is missing" };
    if (head !== null && head.count !== rows.length) {
      return { ok: false, brokenAt: null, reason: `${head.count} events were written but ${rows.length} remain` };
    }
    if (head !== null && head.hash !== prev) return { ok: false, brokenAt: null, reason: "the last event is not the recorded chain head" };

    const events = rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) as unknown }));
    const certified = new Set<string>();
    for (const event of events) {
      const closed = event.type === "CLOSED" ? ClosedPayloadSchema.safeParse(event.payload) : null;
      if (closed?.success) certified.add(closed.data.certificateHash);
    }
    const live = this.db.query("SELECT obligationId, hash, json FROM certificates").all() as CertificateRow[];
    const revoked = this.db.query("SELECT obligationId, hash, json FROM revoked_certificates").all() as CertificateRow[];
    for (const certificate of [...live, ...revoked]) {
      const pinned = PinnedHeadSchema.safeParse(JSON.parse(certificate.json));
      if (!pinned.success || !hashes.has(pinned.data.body.eventChainHead)) {
        return { ok: false, brokenAt: null, reason: `the certificate for obligation ${certificate.obligationId} pins a history that is not in the chain` };
      }
    }
    for (const certificate of live) {
      if (!certified.has(certificate.hash)) {
        return { ok: false, brokenAt: null, reason: `the certificate for obligation ${certificate.obligationId} has no CLOSED event` };
      }
    }

    const replayedObligations = replayObligations(events);
    const obligations = this.db.query("SELECT * FROM obligations").all() as Obligation[];
    const obligationIds = new Set(obligations.map((o) => o.id));
    for (const id of replayedObligations.keys()) {
      if (!obligationIds.has(id)) return { ok: false, brokenAt: null, reason: `obligation ${id} is in the history but missing from the obligations table` };
    }
    for (const obligation of obligations) {
      const r = replayedObligations.get(obligation.id);
      if (!r) return { ok: false, brokenAt: null, reason: `obligation ${obligation.id} has no OBLIGATION_CREATED event` };
      for (const field of ["reference", "amountMinor", "currency", "beneficiaryId", "method", "reason"] as const) {
        if (obligation[field] !== r[field]) {
          return { ok: false, brokenAt: null, reason: `obligation ${obligation.id} has ${field} ${String(obligation[field])} in its table but ${String(r[field])} by its events` };
        }
      }
    }

    const replayed = replayAttempts(events);
    const attempts = this.db.query("SELECT * FROM attempts ORDER BY createdAt").all() as Attempt[];
    const attemptIds = new Set(attempts.map((a) => a.id));
    for (const id of replayed.keys()) {
      if (!attemptIds.has(id)) return { ok: false, brokenAt: null, reason: `attempt ${id} is in the history but missing from the attempts table` };
    }
    for (const attempt of attempts) {
      const r = replayed.get(attempt.id);
      if (!r) return { ok: false, brokenAt: null, reason: `attempt ${attempt.id} has no ATTEMPT_INTENT event` };
      const mismatch = attemptMismatch(attempt, r);
      if (mismatch) return { ok: false, brokenAt: null, reason: `attempt ${attempt.id} ${mismatch}` };
    }

    const replayedConversions = replayConversions(events);
    const conversions = this.db.query("SELECT * FROM conversions ORDER BY createdAt").all() as ConversionAttempt[];
    const conversionIds = new Set(conversions.map((c) => c.id));
    for (const id of replayedConversions.keys()) {
      if (!conversionIds.has(id)) return { ok: false, brokenAt: null, reason: `conversion ${id} is in the history but missing from the conversions table` };
    }
    for (const conversion of conversions) {
      const r = replayedConversions.get(conversion.id);
      if (!r) return { ok: false, brokenAt: null, reason: `conversion ${conversion.id} has no FUNDING_INTENT event` };
      const mismatch = conversionMismatch(conversion, r);
      if (mismatch) return { ok: false, brokenAt: null, reason: `conversion ${conversion.id} ${mismatch}` };
    }

    const webhooks = webhookRowsMismatch(events, this.db.query("SELECT id, name, transferId, receivedAt FROM webhook_events").all() as WebhookRow[]);
    if (webhooks) return { ok: false, brokenAt: null, reason: webhooks };
    const reactions = replayReactions(events);
    if (reactions) return { ok: false, brokenAt: null, reason: reactions };

    const rebaselinedAt = events.findLast((e) => e.type === "CHAIN_REBASELINED")?.ts;
    return { ok: true, head: prev, ...(rebaselinedAt ? { rebaselinedAt } : {}) };
  }

  /**
   * An operator's explicit decision to accept the events as they are and re-pin the recorded head and count: the
   * way out for a file whose `chain_head` fell behind (written by an older build that did not keep it, or opened
   * mid-migration). Every link and hash must still verify; nothing here repairs an edited or cut chain, and it does
   * not touch the tables. The decision itself is chained as `CHAIN_REBASELINED`, and `verifyChain` reports
   * `rebaselinedAt` from then on. Deliberately not offered to agents or over the API.
   */
  rebaselineChain(by: string, note: string): ChainVerification {
    requireHumanNote(by, note);
    return this.tx(() => {
      const rows = this.db.query("SELECT * FROM events ORDER BY seq").all() as EventRow[];
      const links = this.checkLinks(rows);
      if (!links.ok) throw new StateConflict(`cannot re-baseline a chain whose events do not verify: ${links.reason}`);
      const head = this.db.query("SELECT hash, count FROM chain_head WHERE id = 1").get() as HeadRow | null;
      if (head !== null && head.count === rows.length && head.hash === links.head) {
        throw new StateConflict("the recorded chain head already matches the events; there is nothing to re-baseline");
      }
      this.append(null, "CHAIN_REBASELINED", {
        by,
        note,
        recordedHead: head ? { hash: head.hash, count: head.count } : null,
        eventsBefore: rows.length,
        headBefore: rows.length > 0 ? links.head : null,
      });
      this.db
        .query(
          `INSERT INTO chain_head (id, hash, count)
           SELECT 1, hash, (SELECT COUNT(*) FROM events) FROM events ORDER BY seq DESC LIMIT 1
           ON CONFLICT (id) DO UPDATE SET hash = excluded.hash, count = excluded.count`,
        )
        .run();
      return this.verifyChain();
    });
  }
}
