import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { FinancialTransaction, ReconciliationApi } from "../airwallex/types";
import { canonicalJson, sha256Hex } from "../canonical";
import { NotClosable } from "../errors";
import { paidObservedAt } from "../ledger/events";
import type { Attempt, Ledger, Obligation } from "../ledger/ledger";
import { toMinor } from "../money";

/** Signed minor-unit effects on the wallet: payouts and fees are negative, reversals positive. */
const WalletLinesSchema = z.object({
  payoutMinor: z.number().int(),
  feeMinor: z.number().int(),
  reversalMinor: z.number().int(),
});
export type WalletLines = z.infer<typeof WalletLinesSchema>;

const AttemptStateSchema = z.enum(["INTENT", "LIVE", "PAID", "DEAD", "ABANDONED"]);

/** What really happened to the wallet, from Airwallex's own lines. `paidMinor` must equal the amount owed. */
const TotalsSchema = z.object({
  paidMinor: z.number().int(),
  feesMinor: z.number().int(),
  refundedMinor: z.number().int(),
  netWalletMinor: z.number().int(),
});
export type Totals = z.infer<typeof TotalsSchema>;

const CertificateAttemptSchema = z.object({
  seq: z.number().int(),
  attemptId: z.string(),
  requestId: z.string(),
  transferId: z.string().nullable(),
  state: AttemptStateSchema,
  failureCode: z.string().nullable(),
  expected: WalletLinesSchema.nullable(),
  actual: WalletLinesSchema.nullable(),
});

export const ClosureCertificateBodySchema = z.object({
  version: z.literal(1),
  obligationId: z.string(),
  reference: z.string(),
  currency: z.string(),
  amountMinor: z.number().int(),
  beneficiaryId: z.string(),
  settledAttemptId: z.string(),
  settledTransferId: z.string(),
  attempts: z.array(CertificateAttemptSchema),
  totals: TotalsSchema,
  /** Head of the event chain just before this certificate; anchors the whole history. */
  eventChainHead: z.string(),
  issuedAt: z.string(),
});
export type ClosureCertificateBody = z.infer<typeof ClosureCertificateBodySchema>;

export const SignedCertificateSchema = z.object({
  body: ClosureCertificateBodySchema,
  /** sha256 of the canonical body. This is the value to anchor on a chain. */
  hash: z.string(),
  signature: z.string(),
});
export type SignedCertificate = z.infer<typeof SignedCertificateSchema>;

export interface AttemptReconciliation {
  attemptId: string;
  seq: number;
  requestId: string;
  transferId: string | null;
  state: Attempt["state"];
  failureCode: string | null;
  expected: WalletLines | null;
  actual: WalletLines | null;
  problems: string[];
}

export interface Reconciliation {
  obligationId: string;
  reference: string;
  currency: string;
  amountMinor: number;
  closable: boolean;
  blockers: string[];
  attempts: AttemptReconciliation[];
  totals: Totals;
  untrackedTransfers: string[];
  checkedAt: string;
  /** Identifies the ledger state this was computed from; `close` refuses if it moved underneath. */
  fingerprint: string;
}

export interface CloserConfig {
  ledger: Ledger;
  api: ReconciliationApi;
  secret: string;
  now?: () => Date;
  /**
   * PAID is not final: banks can still return a paid transfer. The incident stays open this long after the transfer
   * was first seen PAID. 24h is a placeholder policy; sandbox demos pass a short window explicitly.
   */
  paidHoldMs?: number;
}

const ZERO: WalletLines = { payoutMinor: 0, feeMinor: 0, reversalMinor: 0 };

const signHash = (hash: string, secret: string): string =>
  createHmac("sha256", secret).update(`payonce-certificate-v1|${hash}`).digest("hex");

export function verifyCertificate(certificate: SignedCertificate, secret: string): boolean {
  if (sha256Hex(canonicalJson(certificate.body)) !== certificate.hash) return false;
  const expected = Buffer.from(signHash(certificate.hash, secret), "hex");
  const actual = Buffer.from(certificate.signature, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** What Airwallex must have booked for an attempt that reached its state. A failed transfer keeps its fee. */
function expectedLines(attempt: Attempt): WalletLines | null {
  const fee = attempt.feeMinor ?? 0;
  if (attempt.state === "PAID") return { payoutMinor: -attempt.amountMinor, feeMinor: -fee, reversalMinor: 0 };
  if (attempt.state === "DEAD") return { payoutMinor: -attempt.amountMinor, feeMinor: -fee, reversalMinor: attempt.amountMinor };
  if (attempt.state === "ABANDONED") return ZERO;
  return null;
}

function sumLines(rows: FinancialTransaction[]): { lines: WalletLines; pending: number; unexpected: string[] } {
  const lines: WalletLines = { payoutMinor: 0, feeMinor: 0, reversalMinor: 0 };
  const unexpected: string[] = [];
  let pending = 0;
  for (const row of rows) {
    if (row.status !== "SETTLED") pending++;
    const net = toMinor(row.net, row.currency);
    if (row.transaction_type === "PAYOUT") lines.payoutMinor += net;
    else if (row.transaction_type === "FEE") lines.feeMinor += net;
    else if (row.transaction_type === "PAYOUT_REVERSAL") lines.reversalMinor += net;
    else unexpected.push(`${row.transaction_type} ${row.net} ${row.currency}`);
  }
  return { lines, pending, unexpected };
}

const fingerprintOf = (attempts: Attempt[]): string => attempts.map((a) => `${a.id}:${a.state}:${a.updatedAt}`).join("|");

export class Closer {
  private readonly ledger: Ledger;
  private readonly api: ReconciliationApi;
  private readonly secret: string;
  private readonly now: () => Date;
  private readonly paidHoldMs: number;

  constructor(config: CloserConfig) {
    this.ledger = config.ledger;
    this.api = config.api;
    this.secret = config.secret;
    this.now = config.now ?? (() => new Date());
    this.paidHoldMs = config.paidHoldMs ?? 24 * 3600_000;
  }

  /** Read-only: compares the ledger's beliefs with the wallet lines Airwallex booked. */
  async reconcile(obligationId: string): Promise<Reconciliation> {
    const obligation = this.ledger.requireObligation(obligationId);
    const attempts = this.ledger.attemptsFor(obligationId);
    const blockers: string[] = [];

    const reconciled: AttemptReconciliation[] = [];
    for (const attempt of attempts) reconciled.push(await this.reconcileAttempt(attempt));
    for (const item of reconciled) for (const problem of item.problems) blockers.push(`attempt #${item.seq}: ${problem}`);

    const paid = attempts.filter((a) => a.state === "PAID");
    if (paid.length !== 1) blockers.push(`expected exactly one PAID attempt, found ${paid.length}`);
    else this.checkHoldWindow(paid[0]!, blockers);

    const totals = this.totals(reconciled);
    if (paid.length === 1 && totals.paidMinor !== obligation.amountMinor) {
      blockers.push(`the wallet shows ${totals.paidMinor} minor units left for the supplier, but ${obligation.amountMinor} are owed`);
    }

    const untracked = await this.findUntracked(obligation, attempts);
    for (const id of untracked) blockers.push(`transfer ${id} carries this reference but is not in the ledger`);

    if (obligation.status === "ESCALATED") blockers.push(`obligation is escalated: ${obligation.escalationReason}`);
    const chain = this.ledger.verifyChain();
    if (!chain.ok) blockers.push(`event chain is broken at event ${chain.brokenAt}`);

    return {
      obligationId,
      reference: obligation.reference,
      currency: obligation.currency,
      amountMinor: obligation.amountMinor,
      closable: blockers.length === 0,
      blockers,
      attempts: reconciled,
      totals,
      untrackedTransfers: untracked,
      checkedAt: this.now().toISOString(),
      fingerprint: fingerprintOf(attempts),
    };
  }

  /** Certifies the incident, or throws NotClosable with every reason. Closing twice returns the original certificate. */
  async close(obligationId: string): Promise<SignedCertificate> {
    const stored = this.ledger.getCertificateJson(obligationId);
    if (stored) return SignedCertificateSchema.parse(JSON.parse(stored));

    const reconciliation = await this.reconcile(obligationId);
    if (!reconciliation.closable) throw new NotClosable(obligationId, reconciliation.blockers);

    return this.ledger.tx(() => {
      const attempts = this.ledger.attemptsFor(obligationId);
      if (fingerprintOf(attempts) !== reconciliation.fingerprint) {
        throw new NotClosable(obligationId, ["the ledger changed while reconciling; run it again"]);
      }
      const chain = this.ledger.verifyChain();
      if (!chain.ok) throw new NotClosable(obligationId, [`event chain is broken at event ${chain.brokenAt}`]);

      const obligation = this.ledger.requireObligation(obligationId);
      const settled = attempts.find((a) => a.state === "PAID")!;
      const body: ClosureCertificateBody = {
        version: 1,
        obligationId,
        reference: obligation.reference,
        currency: obligation.currency,
        amountMinor: obligation.amountMinor,
        beneficiaryId: settled.beneficiaryId,
        settledAttemptId: settled.id,
        settledTransferId: settled.transferId!,
        attempts: reconciliation.attempts.map(({ seq, attemptId, requestId, transferId, state, failureCode, expected, actual }) => ({
          seq, attemptId, requestId, transferId, state, failureCode, expected, actual,
        })),
        totals: reconciliation.totals,
        eventChainHead: chain.head,
        issuedAt: this.now().toISOString(),
      };
      const hash = sha256Hex(canonicalJson(body));
      const certificate: SignedCertificate = { body, hash, signature: signHash(hash, this.secret) };

      this.ledger.saveCertificate(obligationId, hash, JSON.stringify(certificate));
      this.ledger.setObligationStatus(obligationId, "CLOSED");
      this.ledger.append(obligationId, "CLOSED", { certificateHash: hash, settledTransferId: settled.transferId });
      return certificate;
    });
  }

  private async reconcileAttempt(attempt: Attempt): Promise<AttemptReconciliation> {
    const expected = expectedLines(attempt);
    const problems: string[] = [];
    const base = {
      attemptId: attempt.id,
      seq: attempt.seq,
      requestId: attempt.requestId,
      transferId: attempt.transferId,
      state: attempt.state,
      failureCode: attempt.failureCode,
      expected,
    };

    if (expected === null) {
      problems.push(`still ${attempt.state}; not final`);
      return { ...base, actual: null, problems };
    }
    if (!attempt.transferId) {
      if (attempt.state !== "ABANDONED") problems.push("no transfer id recorded");
      return { ...base, actual: ZERO, problems };
    }

    const { lines, pending, unexpected } = sumLines(await this.api.listFinancialTransactions(attempt.transferId));
    if (pending > 0) problems.push(`${pending} wallet line(s) still pending`);
    for (const line of unexpected) problems.push(`unexpected wallet line ${line}`);
    for (const key of ["payoutMinor", "feeMinor", "reversalMinor"] as const) {
      if (lines[key] !== expected[key]) problems.push(`${key} is ${lines[key]} at Airwallex, ledger expects ${expected[key]}`);
    }
    return { ...base, actual: lines, problems };
  }

  private checkHoldWindow(paid: Attempt, blockers: string[]): void {
    const paidAt = paidObservedAt(this.ledger.events(paid.obligationId), paid.id);
    if (!paidAt) {
      blockers.push(`no record of when attempt #${paid.seq} became PAID`);
      return;
    }
    const heldMs = this.now().getTime() - Date.parse(paidAt);
    if (heldMs < this.paidHoldMs) {
      const remaining = Math.ceil((this.paidHoldMs - heldMs) / 60_000);
      blockers.push(`PAID is not final: hold window has ${remaining} min left (banks can still return a paid transfer)`);
    }
  }

  private totals(items: AttemptReconciliation[]): Totals {
    let payout = 0;
    let fee = 0;
    let reversal = 0;
    for (const item of items) {
      payout += item.actual?.payoutMinor ?? 0;
      fee += item.actual?.feeMinor ?? 0;
      reversal += item.actual?.reversalMinor ?? 0;
    }
    return { paidMinor: -(payout + reversal), feesMinor: -fee, refundedMinor: reversal, netWalletMinor: payout + fee + reversal };
  }

  /** A transfer carrying our reference that the ledger never created: someone else paid this obligation. */
  private async findUntracked(obligation: Obligation, attempts: Attempt[]): Promise<string[]> {
    const known = new Set(attempts.map((a) => a.transferId).filter((id): id is string => id !== null));
    const since = new Date(Date.parse(obligation.createdAt) - 60_000).toISOString();
    const transfers = await this.api.listTransfers(since);
    return transfers.filter((t) => t.reference === obligation.reference && !known.has(t.id)).map((t) => t.id);
  }
}
