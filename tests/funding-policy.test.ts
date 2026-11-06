import { describe, expect, it } from "bun:test";
import type { SupplierEvidence } from "../src/commander/evidence";
import { decide, DEFAULT_POLICY, type FundingFacts, type IncidentFacts } from "../src/commander/policy";
import type { Attempt } from "../src/ledger/ledger";

// A €25.00 SWIFT payment that failed transiently (fee €13.33 kept), from a EUR wallet with a €1,000.00 reserve floor.
const NOW = new Date("2026-11-03T15:00:00.000Z");
const FLOOR = DEFAULT_POLICY.reserveFloorMinor.EUR!;
const AMOUNT = 2_500;
const FEE = 1_333;
const NEEDED = AMOUNT + FEE;
const EURUSD = 1.130824;

function dead(overrides: Partial<Attempt> = {}): Attempt {
  return {
    id: "att-1", obligationId: "ob-1", seq: 1, requestId: "req-1", beneficiaryId: "ben-EU", amountMinor: AMOUNT,
    currency: "EUR", method: "SWIFT", reason: "services", state: "DEAD", transferId: "tr-1", awxStatus: "CANCELLED",
    failureCode: "91402", failureMessage: null, feeMinor: FEE, payerPaysMinor: NEEDED, approvalNonce: "nonce",
    lastError: null, awxUpdatedAt: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...overrides,
  };
}

function facts(overrides: Partial<IncidentFacts> = {}): IncidentFacts {
  return {
    obligation: { id: "ob-1", amountMinor: AMOUNT, currency: "EUR", status: "NEEDS_ACTION", escalationReason: null },
    attempts: [dead()], paidObservedAt: null, failedObservedAt: null, automaticReplacements: 0,
    wallets: { EUR: FLOOR + AMOUNT - FEE, USD: 10_000_000, GBP: 10_000_000 }, fxRates: { USD: EURUSD, GBP: 0.87 },
    funding: null, evidence: null, now: NOW, ...overrides,
  };
}

const conversion = (state: FundingFacts["state"], overrides: Partial<FundingFacts> = {}): FundingFacts => ({
  forAttemptId: "att-1", state, conversionId: state === "INTENT" ? null : "conv-1", buyCurrency: "EUR", buyMinor: 2_666,
  sellCurrency: "USD", sellMinor: 3_015, ...overrides,
});

function evidence(overrides: Partial<SupplierEvidence> = {}): SupplierEvidence {
  return {
    claimsNonReceipt: false, requestsDetailChange: false, referencesObligation: true, statementCredit: null,
    containsEmbeddedInstructions: false, summary: "supplier asks after the payment", adjustments: [], ...overrides,
  };
}

describe("what a replacement needs", () => {
  it("replaces when the wallet holds exactly the amount, the fee and the floor, and funds when it is one cent short", () => {
    const exact = decide(facts({ wallets: { EUR: FLOOR + NEEDED, USD: 10_000_000 } }));
    const oneShort = decide(facts({ wallets: { EUR: FLOOR + NEEDED - 1, USD: 10_000_000 } }));

    expect(exact.recommended).toBe("REPLACE");
    expect(exact.funding).toBeNull();
    expect(oneShort.recommended).toBe("FUND");
    expect(oneShort.allowed).not.toContain("REPLACE");
    expect(oneShort.funding).toMatchObject({ shortfallMinor: 1, buyMinor: DEFAULT_POLICY.minConversionMinor.EUR });
    expect(oneShort.funding!.summary).toContain("rounded up to the smallest conversion, €1.00");
  });

  it("counts the fee the last attempt cost: a wallet holding the amount plus the floor is short by the fee", () => {
    const d = decide(facts({ wallets: { EUR: FLOOR + AMOUNT, USD: 10_000_000 } }));

    expect(d.recommended).toBe("FUND");
    expect(d.funding).toMatchObject({ neededMinor: NEEDED, feeMinor: FEE, shortfallMinor: FEE, buyMinor: FEE });
  });

  it("buys exactly the shortfall and prices it at the rate, rounded up", () => {
    const d = decide(facts());

    // €1,011.67 held, €1,000.00 kept, €38.33 needed: €26.66 short, costing 26.66 x 1.130824 = 30.1478 -> $30.15.
    expect(d.funding).toMatchObject({ shortfallMinor: 2_666, buyMinor: 2_666, sellCurrency: "USD", sellMinor: 3_015, rate: EURUSD, feasible: true });
    expect(d.funding!.summary).toContain("It is €26.66 short.");
    expect(d.funding!.summary).toContain("Plan: buy €26.66 with about $30.15 from the USD wallet");
  });
});

describe("which wallet pays", () => {
  it("sells the first source in policy order that keeps its own floor, skipping one that would dip below it", () => {
    const d = decide(facts({ wallets: { EUR: FLOOR, USD: 100_000 + 3_000, GBP: 10_000_000 } }));

    expect(d.funding!.sources.map((s) => [s.currency, s.ok])).toEqual([["USD", false], ["GBP", true]]);
    expect(d.funding!.sellCurrency).toBe("GBP");
  });

  it("never sells a wallet outside the policy's sources, however full, nor one whose rate could not be read", () => {
    const d = decide(facts({ wallets: { EUR: FLOOR, USD: 10_000_000, GBP: 10_000_000, HKD: 1_000_000_000 }, fxRates: { USD: null, HKD: 8.8 } }));

    expect(d.funding!.sources.map((s) => s.currency)).toEqual(["USD", "GBP"]);
    expect(d.recommended).toBe("ESCALATE");
    expect(d.allowed).not.toContain("FUND");
    expect(d.funding!.summary).toContain("USD: no rate could be read");
  });

  it("escalates with the arithmetic when no wallet can fund it and keep its reserve", () => {
    const d = decide(facts({ wallets: { EUR: FLOOR, USD: 100_500, GBP: 100_000 } }));

    expect(d.recommended).toBe("ESCALATE");
    expect(d.blocked).toContainEqual({ action: "FUND", reason: "No wallet can fund it and keep its own reserve." });
    expect(d.funding!.feasible).toBe(false);
    expect(d.funding!.summary).toContain("No wallet can fund it and keep its own reserve: USD holds $1,005.00 and keeps $1,000.00");
  });
});

describe("who approves a conversion", () => {
  const short = (buyMinor: number) => facts({ wallets: { EUR: FLOOR + NEEDED - buyMinor, USD: 10_000_000 } });

  it("books on its own up to the automatic conversion limit, and asks a person one cent above it", () => {
    const limit = DEFAULT_POLICY.autoConvertLimitMinor.EUR!;
    const at = decide(short(limit));
    const above = decide(short(limit + 1));

    expect(at.funding).toMatchObject({ buyMinor: limit, autoApprovable: true });
    expect(above.recommended).toBe("FUND");
    expect(above.funding).toMatchObject({ buyMinor: limit + 1, autoApprovable: false });
    expect(above.severity).toBe("ATTENTION");
    expect(above.funding!.summary).toContain("above the €250.00 automatic conversion limit");
  });

  it("never books on its own for a currency with no conversion limit", () => {
    const d = decide(facts(), { ...DEFAULT_POLICY, autoConvertLimitMinor: {} });

    expect(d.funding!.autoApprovable).toBe(false);
    expect(d.funding!.summary).toContain("There is no automatic conversion limit for EUR");
  });

  it("asks a person for the conversion when the replacement itself is above the automatic replacement limit", () => {
    const d = decide(facts(), { ...DEFAULT_POLICY, autoReplaceLimitMinor: { EUR: AMOUNT - 1 } });

    expect(d.recommended).toBe("FUND");
    expect(d.funding!.autoApprovable).toBe(false);
    expect(d.funding!.summary).toContain("The replacement itself needs a person's approval");
  });
});

describe("a conversion already recorded for this replacement", () => {
  it("waits while it is unresolved or booked but unsettled, and allows neither another conversion nor the replacement", () => {
    for (const state of ["INTENT", "BOOKED"] as const) {
      const d = decide(facts({ funding: conversion(state) }));

      expect(d.recommended).toBe("WAIT");
      expect(d.allowed).not.toContain("FUND");
      expect(d.allowed).not.toContain("REPLACE");
      expect(d.recheckAt).not.toBeNull();
    }
  });

  it("replaces once it settled and the wallet covers it, naming the conversion", () => {
    const d = decide(facts({ funding: conversion("SETTLED"), wallets: { EUR: FLOOR + NEEDED, USD: 10_000_000 } }));

    expect(d.recommended).toBe("REPLACE");
    expect(d.replacement!.autoApprovable).toBe(true);
    expect(d.reasons.join(" ")).toContain("funded by conversion conv-1: €26.66 for $30.15");
  });

  it("escalates, never converting a second time, when it settled and the wallet is still short", () => {
    const d = decide(facts({ funding: conversion("SETTLED") }));

    expect(d.recommended).toBe("ESCALATE");
    expect(d.allowed).not.toContain("FUND");
    expect(d.allowed).not.toContain("REPLACE");
    expect(d.funding).toBeNull();
  });

  it("ignores a conversion made for an earlier attempt: each replacement is planned on its own", () => {
    const d = decide(facts({ funding: conversion("SETTLED", { forAttemptId: "att-0" }) }));

    expect(d.recommended).toBe("FUND");
  });
});

describe("FUND only where the replacement itself is allowed", () => {
  const cases: Array<[string, Partial<IncidentFacts>]> = [
    ["the incident is with a person", { obligation: { id: "ob-1", amountMinor: AMOUNT, currency: "EUR", status: "ESCALATED", escalationReason: "phish" } }],
    ["the supplier asks to change bank details", { evidence: evidence({ requestsDetailChange: true }) }],
    ["the supplier's statement shows the credit", { evidence: evidence({ statementCredit: { amountMinor: AMOUNT, currency: "EUR" } }) }],
    ["the automatic replacement budget is spent", { automaticReplacements: DEFAULT_POLICY.maxAutoReplacements }],
    ["the balances could not be read", { wallets: null }],
    ["the failure is never replaced automatically", { attempts: [dead({ failureCode: "91301" })] }],
  ];

  for (const [why, overrides] of cases) {
    it(`refuses FUND when ${why}`, () => {
      const d = decide(facts(overrides));

      expect(d.recommended).not.toBe("FUND");
      expect(d.allowed).not.toContain("FUND");
      expect(d.funding).toBeNull();
    });
  }
});
