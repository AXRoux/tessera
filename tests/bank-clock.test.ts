import { describe, expect, it } from "bun:test";
import { BankClock, DEFAULT_BANK_CLOCK_MS, parseBankClockMs } from "../src/server/bank-clock";
import { buildRuntime, OFFLINE_BENEFICIARIES } from "../src/server/runtime";

/** An offline runtime with one supplier payment made the ordinary way: assessed, approved by a person, submitted. */
async function paying() {
  const runtime = buildRuntime({ TESSERA_OFFLINE: "1" });
  const { ledger, commander, gateway } = runtime;
  const pay = async (reference: string) => {
    const obligation = ledger.createObligation({ reference, beneficiaryId: OFFLINE_BENEFICIARIES[0]!.id, amountMinor: 2_500, currency: "USD", method: "LOCAL", reason: "professional_business_services" });
    const { evidenceHash } = await commander.assess(obligation.id);
    await gateway.submit(await commander.humanApproval({ obligationId: obligation.id, approver: "ops@acme.example", note: "invoice run", evidenceHash }));
    return obligation.id;
  };
  return { runtime, pay };
}

describe("the bank clock: Tessera answers for the bank where there is none", () => {
  it("sends and pays a payout nobody has touched, once it has waited, and the ledger records it as paid", async () => {
    const { runtime, pay } = await paying();
    const id = await pay("INV-001");
    const attempt = runtime.ledger.latestAttempt(id)!;
    expect(attempt.awxStatus).toBe("PROCESSING");
    const created = Date.parse(attempt.createdAt);

    const early = new BankClock({ ledger: runtime.ledger, gateway: runtime.gateway, simulator: runtime.simulator!, afterMs: 15_000, now: () => created + 14_000 });
    expect(await early.tick()).toEqual([]);
    expect(runtime.ledger.latestAttempt(id)!.awxStatus).toBe("PROCESSING");

    const due = new BankClock({ ledger: runtime.ledger, gateway: runtime.gateway, simulator: runtime.simulator!, afterMs: 15_000, now: () => created + 15_000 });
    expect(await due.tick()).toEqual([attempt.transferId!]);
    expect(runtime.ledger.latestAttempt(id)).toMatchObject({ state: "PAID", awxStatus: "PAID" });
    expect(await due.tick()).toEqual([]); // paid once, never again
  });

  it("leaves alone a transfer a person (or the demo) has already moved, so a failure can still be rehearsed", async () => {
    const { runtime, pay } = await paying();
    const id = await pay("INV-002");
    const transferId = runtime.ledger.latestAttempt(id)!.transferId!;
    await runtime.simulator!.advance(transferId, "SENT"); // a person pressed "Mark sent" in Simulate
    await runtime.gateway.sync(id);
    const later = new BankClock({ ledger: runtime.ledger, gateway: runtime.gateway, simulator: runtime.simulator!, afterMs: 0, now: () => Date.now() + 3_600_000 });
    expect(await later.tick()).toEqual([]);
    expect(runtime.ledger.latestAttempt(id)!.awxStatus).toBe("SENT");
  });

  it("runs only where there is no bank: on by default offline and on the sandbox, never against production", () => {
    expect(buildRuntime({ TESSERA_OFFLINE: "1" }).bankClockMs).toBe(DEFAULT_BANK_CLOCK_MS);
    expect(buildRuntime({ TESSERA_OFFLINE: "1", TESSERA_BANK_CLOCK_MS: "0" }).bankClockMs).toBe(0);
    const production = { AWX_BASE_URL: "https://api.airwallex.com", AWX_CLIENT_ID: "c", AWX_API_KEY: "k", TESSERA_APPROVAL_SECRET: "s".repeat(32), TESSERA_DB: ":memory:", TESSERA_BANK_CLOCK_MS: "1000" };
    expect(buildRuntime(production).bankClockMs).toBe(0);
    expect(() => parseBankClockMs("soon", 1)).toThrow("TESSERA_BANK_CLOCK_MS must be a whole number");
  });
});
