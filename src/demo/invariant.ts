/**
 * The property every demo ends on: at most one open payout per invoice, both in the ledger and at Airwallex, and a
 * hash chain that verifies. Shared by the agent demo, the offline smoke and the scale run.
 */
import type { ReconciliationApi } from "../airwallex/types";
import type { Ledger } from "../ledger/ledger";

export interface InvoiceCheck {
  id: string;
  reference: string;
  status: string;
  attempts: number;
  /** Attempts holding the lock: INTENT, LIVE or PAID. */
  openAttempts: number;
  /** Transfers at Airwallex for this reference that are neither CANCELLED nor FAILED. */
  liveTransfers: number;
  ok: boolean;
}

export interface InvariantReport {
  ok: boolean;
  chainOk: boolean;
  invoices: InvoiceCheck[];
}

/** Checks `obligationIds` against the ledger and against every transfer Airwallex lists since `since`. */
export async function checkInvariant(ledger: Ledger, api: ReconciliationApi, obligationIds: string[], since: string): Promise<InvariantReport> {
  const remote = await api.listTransfers(since);
  const invoices = obligationIds.map((id): InvoiceCheck => {
    const o = ledger.requireObligation(id);
    const attempts = ledger.attemptsFor(id);
    const openAttempts = attempts.filter((a) => a.state === "INTENT" || a.state === "LIVE" || a.state === "PAID").length;
    const liveTransfers = remote.filter((t) => t.reference === o.reference && t.status !== "CANCELLED" && t.status !== "FAILED").length;
    return {
      id, reference: o.reference, status: o.status, attempts: attempts.length, openAttempts, liveTransfers,
      ok: openAttempts <= 1 && liveTransfers <= 1,
    };
  });
  const chainOk = ledger.verifyChain().ok;
  return { ok: chainOk && invoices.every((i) => i.ok), chainOk, invoices };
}
