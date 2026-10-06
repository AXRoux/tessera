import { describe, expect, it } from "bun:test";
import type { SupplierEvidence } from "../src/commander/evidence";
import { decide, DEFAULT_POLICY, type IncidentFacts } from "../src/commander/policy";
import type { Attempt } from "../src/ledger/ledger";

const NOW = new Date("2026-10-20T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();

function attempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    id: "att-1", obligationId: "ob-1", seq: 1, requestId: "req-1", beneficiaryId: "ben-A", amountMinor: 10_000,
    currency: "USD", method: "LOCAL", reason: "services", state: "LIVE", transferId: "tr-1", awxStatus: "SENT",
    failureCode: null, failureMessage: null, feeMinor: 300, payerPaysMinor: 10_300, approvalNonce: "nonce",
    lastError: null, createdAt: hoursAgo(1), updatedAt: hoursAgo(1), ...overrides,
  };
}

function evidence(overrides: Partial<SupplierEvidence> = {}): SupplierEvidence {
  return {
    claimsNonReceipt: true, requestsDetailChange: false, referencesObligation: true, statementCredit: null,
    containsEmbeddedInstructions: false, summary: "supplier says nothing arrived", adjustments: [], ...overrides,
  };
}

function facts(attempts: Attempt[], overrides: Partial<IncidentFacts> = {}): IncidentFacts {
  return {
    obligation: { id: "ob-1", amountMinor: 10_000, currency: "USD", status: "PAYING", escalationReason: null },
    attempts, paidObservedAt: null, walletAvailableMinor: 1_000_000, evidence: null, now: NOW, ...overrides,
  };
}

describe("waiting is a decision", () => {
  it("waits, with a recheck time, while a transfer is inside its settlement window", () => {
    const d = decide(facts([attempt({ createdAt: hoursAgo(10) })], { evidence: evidence() }));

    expect(d.recommended).toBe("WAIT");
    expect(d.recheckAt).toBe(new Date(Date.parse(hoursAgo(10)) + 48 * 3600_000).toISOString());
    expect(d.blocked.map((b) => b.action)).toContain("REPLACE");
    expect(d.allowed).not.toContain("REPLACE");
  });

  it("allows more patience for SWIFT than for LOCAL", () => {
    const local = decide(facts([attempt({ createdAt: hoursAgo(60), method: "LOCAL" })]));
    const swift = decide(facts([attempt({ createdAt: hoursAgo(60), method: "SWIFT" })]));

    expect(local.recommended).toBe("ESCALATE");
    expect(swift.recommended).toBe("WAIT");
  });

  it("never replaces an overdue transfer: it may still settle", () => {
    const d = decide(facts([attempt({ createdAt: hoursAgo(200) })]));

    expect(d.recommended).toBe("ESCALATE");
    expect(d.allowed).not.toContain("REPLACE");
  });

  it("keeps waiting after FAILED until Airwallex returns the funds", () => {
    const d = decide(facts([attempt({ awxStatus: "FAILED", failureCode: "91401" })]));

    expect(d.recommended).toBe("WAIT");
    expect(d.allowed).not.toContain("REPLACE");
  });
});

describe("PAID", () => {
  it("answers a non-receipt claim with proof, never a second payment", () => {
    const d = decide(facts([attempt({ state: "PAID", awxStatus: "PAID" })], { evidence: evidence() }));

    expect(d.recommended).toBe("SEND_PROOF_TO_SUPPLIER");
    expect(d.allowed).not.toContain("REPLACE");
  });

  it("holds before closing, then allows close once the hold passes", () => {
    const paid = attempt({ state: "PAID", awxStatus: "PAID" });

    const early = decide(facts([paid], { paidObservedAt: hoursAgo(2) }));
    const late = decide(facts([paid], { paidObservedAt: hoursAgo(30) }));

    expect(early.recommended).toBe("WAIT");
    expect(late.recommended).toBe("CLOSE");
  });

  it("closes on the supplier's own statement showing the credit, once held", () => {
    const paid = attempt({ state: "PAID", awxStatus: "PAID" });
    const e = evidence({ claimsNonReceipt: false, statementCredit: { amountMinor: 10_000, currency: "USD" } });

    const d = decide(facts([paid], { paidObservedAt: hoursAgo(30), evidence: e }));

    expect(d.recommended).toBe("CLOSE");
  });
});

describe("a returned transfer", () => {
  const dead = (failureCode: string, extra: Partial<Attempt> = {}) => attempt({ state: "DEAD", awxStatus: "CANCELLED", failureCode, ...extra });

  it("replaces automatically after a transient failure inside the limit", () => {
    const d = decide(facts([dead("91402")]));

    expect(d.recommended).toBe("REPLACE");
    expect(d.replacement?.autoApprovable).toBe(true);
  });

  it("needs a human above the automatic limit", () => {
    const d = decide(facts([dead("91402", { amountMinor: 600_000 })]));

    expect(d.recommended).toBe("REPLACE");
    expect(d.replacement?.autoApprovable).toBe(false);
  });

  it("asks for a correction when the supplier's account refused the funds", () => {
    const d = decide(facts([dead("90802")]));

    expect(d.recommended).toBe("REQUEST_CORRECTION");
    expect(d.allowed).not.toContain("REPLACE");
    expect(d.replacement?.needsChange).toBe("beneficiary");
  });

  it("escalates a possible duplicate as critical", () => {
    const d = decide(facts([dead("91301")]));

    expect(d.recommended).toBe("ESCALATE");
    expect(d.severity).toBe("CRITICAL");
  });

  it("escalates a compliance hold or recall", () => {
    for (const code of ["90502", "91001"]) {
      const d = decide(facts([dead(code)]));
      expect(d.recommended, code).toBe("ESCALATE");
      expect(d.allowed, code).not.toContain("REPLACE");
    }
  });

  it("refuses to replace when the wallet cannot cover amount plus fee", () => {
    const d = decide(facts([dead("91402")], { walletAvailableMinor: 10_200 }));

    expect(d.recommended).toBe("ESCALATE");
    expect(d.allowed).not.toContain("REPLACE");
    expect(d.blocked.map((b) => b.action)).toContain("REPLACE");
  });

  it("blocks replacement when the supplier's statement shows they already hold the money", () => {
    const e = evidence({ statementCredit: { amountMinor: 10_000, currency: "USD" } });

    const d = decide(facts([dead("91402")], { evidence: e }));

    expect(d.recommended).toBe("ESCALATE");
    expect(d.severity).toBe("CRITICAL");
    expect(d.allowed).not.toContain("REPLACE");
  });

  it("fails closed on a code it has never seen", () => {
    const d = decide(facts([dead("12345")]));

    expect(d.recommended).toBe("ESCALATE");
    expect(d.allowed).not.toContain("REPLACE");
  });
});

describe("signals that override everything", () => {
  it("escalates a bank-detail change request even when the failure would normally replace", () => {
    const e = evidence({ requestsDetailChange: true });

    const d = decide(facts([attempt({ state: "DEAD", awxStatus: "CANCELLED", failureCode: "91402" })], { evidence: e }));

    expect(d.recommended).toBe("ESCALATE");
    expect(d.severity).toBe("CRITICAL");
    expect(d.allowed).not.toContain("REPLACE");
  });

  it("notes embedded instructions without letting them change the decision", () => {
    const quiet = evidence({ claimsNonReceipt: false });
    const clean = decide(facts([attempt()], { evidence: quiet }));
    const injected = decide(facts([attempt()], { evidence: { ...quiet, containsEmbeddedInstructions: true } }));

    expect(injected.recommended).toBe(clean.recommended);
    expect(injected.allowed).toEqual(clean.allowed);
    expect(clean.severity).toBe("ROUTINE");
    expect(injected.severity).toBe("ATTENTION");
  });

  it("treats an escalated obligation as needing a human", () => {
    const f = facts([attempt({ state: "DEAD", awxStatus: "CANCELLED", failureCode: "91402" })], {
      obligation: { id: "ob-1", amountMinor: 10_000, currency: "USD", status: "ESCALATED", escalationReason: "mismatch" },
    });

    const d = decide(f);

    expect(d.recommended).toBe("ESCALATE");
    expect(d.allowed).not.toContain("REPLACE");
  });

  it("does nothing for a closed obligation or one never paid", () => {
    const closed = decide(facts([attempt({ state: "PAID" })], {
      obligation: { id: "ob-1", amountMinor: 10_000, currency: "USD", status: "CLOSED", escalationReason: null },
    }));
    const unpaid = decide(facts([]));

    expect(closed.recommended).toBe("NONE");
    expect(unpaid.recommended).toBe("NONE");
  });

  it("uses the configured policy, not hidden constants", () => {
    const strict = { ...DEFAULT_POLICY, settlementSlaHours: { LOCAL: 1, SWIFT: 1 } };

    const d = decide(facts([attempt({ createdAt: hoursAgo(10) })]), strict);

    expect(d.recommended).toBe("ESCALATE");
  });
});
