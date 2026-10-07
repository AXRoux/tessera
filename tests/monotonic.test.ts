import { describe, expect, it } from "bun:test";
import type { SupplierEvidence } from "../src/commander/evidence";
import { PLAYBOOK } from "../src/domain/playbook";
import { decide, type IncidentFacts } from "../src/commander/policy";
import type { Attempt } from "../src/ledger/ledger";

/**
 * The property that makes it safe to let an agent, or a supplier, supply evidence: evidence can only make Tessera
 * more cautious. It can never turn a refused replacement into an allowed one.
 */
const NOW = new Date("2026-01-10T12:00:00Z");

const attempt = (state: Attempt["state"], failureCode: string | null, awxStatus: string | null): Attempt => ({
  id: "att-1", obligationId: "ob-1", seq: 1, requestId: "req-1", beneficiaryId: "ben-A", amountMinor: 2_500, currency: "USD",
  method: "LOCAL", reason: "r", state, transferId: "tr-1", awxStatus, failureCode, failureMessage: null, feeMinor: 300,
  payerPaysMinor: 2_800, approvalNonce: "n".repeat(16), lastError: null,
  createdAt: new Date(NOW.getTime() - 3600_000).toISOString(), updatedAt: NOW.toISOString(),
});

const facts = (latest: Attempt, evidence: SupplierEvidence | null, status = "PAYING" as const): IncidentFacts => ({
  obligation: { id: "ob-1", amountMinor: 2_500, currency: "USD", status, escalationReason: null },
  attempts: [latest],
  paidObservedAt: latest.state === "PAID" ? new Date(NOW.getTime() - 60_000).toISOString() : null,
  walletAvailableMinor: 1_000_000,
  evidence,
  now: NOW,
});

function allEvidence(): SupplierEvidence[] {
  const out: SupplierEvidence[] = [];
  for (const claimsNonReceipt of [true, false])
    for (const requestsDetailChange of [true, false])
      for (const referencesObligation of [true, false])
        for (const containsEmbeddedInstructions of [true, false])
          for (const credit of [null, 2_500, 1_000])
            out.push({
              claimsNonReceipt, requestsDetailChange, referencesObligation, containsEmbeddedInstructions,
              statementCredit: credit === null ? null : { amountMinor: credit, currency: "USD" }, summary: "", adjustments: [],
            });
  return out;
}

describe("evidence is monotone toward caution", () => {
  const codes = [...Object.keys(PLAYBOOK), "unknown-code", null];
  const states: Attempt[] = [
    ...codes.map((code) => attempt("DEAD", code, "CANCELLED")),
    attempt("LIVE", null, "PROCESSING"), attempt("LIVE", null, "FAILED"), attempt("INTENT", null, null),
    attempt("PAID", null, "PAID"), attempt("ABANDONED", null, null),
  ];

  it("never allows REPLACE, or makes it automatic, when the same facts without evidence did not", () => {
    let checked = 0;
    for (const latest of states) {
      const bare = decide(facts(latest, null));
      for (const evidence of allEvidence()) {
        const withEvidence = decide(facts(latest, evidence));
        if (!bare.allowed.includes("REPLACE")) expect(withEvidence.allowed).not.toContain("REPLACE");
        if (!bare.replacement?.autoApprovable) expect(withEvidence.replacement?.autoApprovable ?? false).toBe(false);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1_000);
  });

  it("never recommends CLOSE unless the same facts without evidence did", () => {
    for (const latest of states) {
      const bare = decide(facts(latest, null));
      for (const evidence of allEvidence()) {
        if (bare.recommended !== "CLOSE") expect(decide(facts(latest, evidence)).recommended).not.toBe("CLOSE");
      }
    }
  });
});
