import { describe, expect, it } from "bun:test";
import { Commander } from "../src/commander/commander";
import { effectiveEvidence, type SupplierEvidence } from "../src/commander/evidence";
import { DEFAULT_POLICY } from "../src/commander/policy";
import { ApprovalRejected, AutoReplacementRefused } from "../src/errors";
import { approve, killedAttempt, SECRET, world, type World } from "./helpers/world";

const commanderFor = (w: World): Commander =>
  new Commander({ ledger: w.ledger, gateway: w.gateway, balances: w.api, secret: SECRET });

const evidence = (overrides: Partial<SupplierEvidence> = {}): SupplierEvidence => ({
  claimsNonReceipt: true, requestsDetailChange: false, referencesObligation: true, statementCredit: null,
  containsEmbeddedInstructions: false, summary: "supplier says nothing arrived", adjustments: [], ...overrides,
});

describe("assessing an incident", () => {
  it("refreshes from Airwallex before deciding", async () => {
    const w = world();
    const { attempt } = await w.gateway.submit(approve(w.obligation));
    w.api.advance(attempt.transferId!, "FAILED", "91402");
    w.api.advance(attempt.transferId!, "CANCELLED", "91402");

    const { decision } = await commanderFor(w).assess(w.obligation.id);

    expect(decision.recommended).toBe("REPLACE");
  });

  it("binds the evidence hash to the evidence it was given", async () => {
    const w = world();
    await killedAttempt(w, "91402");
    const commander = commanderFor(w);

    const plain = await commander.assess(w.obligation.id, null);
    const withClaim = await commander.assess(w.obligation.id, evidence());

    expect(plain.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(withClaim.evidenceHash).not.toBe(plain.evidenceHash);
  });
});

describe("replacing without a human", () => {
  it("pays again after a transient failure, under a policy approval bound to the evidence", async () => {
    const w = world();
    const dead = await killedAttempt(w, "91402");

    const { outcome, attempt } = await commanderFor(w).replaceAutomatically(w.obligation.id);

    expect(outcome).toBe("CREATED");
    expect(attempt.seq).toBe(2);
    const intent = w.ledger.events(w.obligation.id).filter((e) => e.type === "ATTEMPT_INTENT").at(-1)!;
    expect(intent.payload).toMatchObject({ mode: "POLICY", approver: "policy:commander", replaces: dead.id });
  });

  it("refuses when the supplier's account refused the funds", async () => {
    const w = world();
    await killedAttempt(w, "90802");

    await expect(commanderFor(w).replaceAutomatically(w.obligation.id)).rejects.toBeInstanceOf(AutoReplacementRefused);
    expect(w.api.all).toHaveLength(1);
  });

  it("refuses when the wallet cannot cover the replacement", async () => {
    const w = world();
    await killedAttempt(w, "91402");
    w.api.balances.set("USD", 102);

    await expect(commanderFor(w).replaceAutomatically(w.obligation.id)).rejects.toBeInstanceOf(AutoReplacementRefused);
  });

  it("refuses when the wallet balance cannot be read, rather than assuming there is enough", async () => {
    const w = world();
    await killedAttempt(w, "91402");
    const commander = new Commander({
      ledger: w.ledger, gateway: w.gateway, secret: SECRET,
      balances: { getBalances: async () => { throw new Error("balance service is down"); } },
    });

    await expect(commander.replaceAutomatically(w.obligation.id)).rejects.toBeInstanceOf(AutoReplacementRefused);
    expect(w.api.all).toHaveLength(1);
  });

  it("refuses when the supplier asked to change bank details", async () => {
    const w = world();
    await killedAttempt(w, "91402");

    await expect(
      commanderFor(w).replaceAutomatically(w.obligation.id, evidence({ requestsDetailChange: true })),
    ).rejects.toBeInstanceOf(AutoReplacementRefused);
    expect(w.api.all).toHaveLength(1);
  });

  it("refuses when the supplier's statement shows they already hold the money", async () => {
    const w = world();
    await killedAttempt(w, "91402");

    await expect(
      commanderFor(w).replaceAutomatically(w.obligation.id, evidence({ statementCredit: { amountMinor: 10_000, currency: "USD" } })),
    ).rejects.toBeInstanceOf(AutoReplacementRefused);
  });
});

describe("replacing with a named human", () => {
  it("lets a human release a possible duplicate, and records who and why", async () => {
    const w = world();
    await killedAttempt(w, "91301");
    const commander = commanderFor(w);

    const approval = await commander.humanApproval({
      obligationId: w.obligation.id,
      evidenceHash: (await commander.assess(w.obligation.id)).evidenceHash,
      approver: "cfo@acme.example",
      note: "supplier's bank confirmed no credit by phone callback",
    });
    const { outcome } = await w.gateway.submit(approval);

    expect(outcome).toBe("CREATED");
    const intent = w.ledger.events(w.obligation.id).filter((e) => e.type === "ATTEMPT_INTENT").at(-1)!;
    expect(intent.payload).toMatchObject({ mode: "HUMAN", approver: "cfo@acme.example", replacesFailureCode: "91301" });
  });

  it("still refuses a human who gives no real reason", async () => {
    const w = world();
    await killedAttempt(w, "91301");
    const commander = commanderFor(w);
    const approval = await commander.humanApproval({
      obligationId: w.obligation.id, approver: "cfo@acme.example", note: "ok", evidenceHash: (await commander.assess(w.obligation.id)).evidenceHash,
    });

    await expect(w.gateway.submit(approval)).rejects.toMatchObject({ name: "ReplacementDenied" });
    expect(w.api.all).toHaveLength(1);
  });

  it("carries a corrected beneficiary into the new attempt", async () => {
    const w = world();
    await killedAttempt(w, "90101");
    const commander = commanderFor(w);
    const approval = await commander.humanApproval({
      obligationId: w.obligation.id,
      evidenceHash: (await commander.assess(w.obligation.id)).evidenceHash,
      approver: "ap@acme.example",
      note: "new account verified by callback",
      beneficiaryId: "ben-B",
    });

    const { attempt } = await w.gateway.submit(approval);

    expect(attempt.beneficiaryId).toBe("ben-B");
  });
});

describe("evidence cannot be laundered", () => {
  const record = (w: World, e: SupplierEvidence, source: "manual" | "model" = "model", enteredBy = "agent:test") =>
    w.ledger.append(w.obligation.id, "EVIDENCE_RECORDED", { evidence: e, source, enteredBy, message: null });
  const current = (w: World) => effectiveEvidence(w.ledger.events(w.obligation.id), w.obligation.amountMinor)?.evidence ?? null;
  const innocent = evidence({ claimsNonReceipt: false, summary: "thanks, all good" });

  it("keeps refusing after a phishing message is followed by an innocent one", async () => {
    const w = world();
    await killedAttempt(w, "91402");
    record(w, evidence({ requestsDetailChange: true }));
    record(w, innocent);

    await expect(commanderFor(w).replaceAutomatically(w.obligation.id, current(w))).rejects.toBeInstanceOf(AutoReplacementRefused);
    expect(w.api.all).toHaveLength(1);
  });

  it("keeps refusing after a statement credit is followed by an innocent message", async () => {
    const w = world();
    await killedAttempt(w, "91402");
    record(w, evidence({ statementCredit: { amountMinor: w.obligation.amountMinor, currency: "USD" } }));
    record(w, innocent);

    await expect(commanderFor(w).replaceAutomatically(w.obligation.id, current(w))).rejects.toBeInstanceOf(AutoReplacementRefused);
  });

  it("lets an operator's manual entry clear earlier warnings", async () => {
    const w = world();
    await killedAttempt(w, "91402");
    record(w, evidence({ requestsDetailChange: true }));
    record(w, innocent, "manual", "ap@acme.example");

    const { outcome } = await commanderFor(w).replaceAutomatically(w.obligation.id, current(w));
    expect(outcome).toBe("CREATED");
  });
});

describe("limits on automatic replacement", () => {
  it("escalates the third automatic replacement of the same invoice", async () => {
    const w = world();
    const commander = commanderFor(w);
    await killedAttempt(w, "91402");
    for (let i = 0; i < 2; i++) {
      const { attempt } = await commander.replaceAutomatically(w.obligation.id);
      w.api.advance(attempt.transferId!, "FAILED", "91402");
      w.api.advance(attempt.transferId!, "CANCELLED", "91402");
    }

    await expect(commander.replaceAutomatically(w.obligation.id)).rejects.toBeInstanceOf(AutoReplacementRefused);
    expect(w.api.all).toHaveLength(3);
    expect((await commander.assess(w.obligation.id)).decision.recommended).toBe("ESCALATE");
  });
});

describe("two-step human approval", () => {
  it("rejects an approval of an assessment that has since changed", async () => {
    const w = world();
    await killedAttempt(w, "91301");
    const commander = commanderFor(w);
    const seen = await commander.assess(w.obligation.id, null);

    const promise = commander.humanApproval({
      obligationId: w.obligation.id, approver: "cfo@acme.example", evidenceHash: seen.evidenceHash,
      note: "supplier's bank confirmed no credit by phone callback", evidence: evidence({ requestsDetailChange: true }),
    });

    await expect(promise).rejects.toBeInstanceOf(ApprovalRejected);
    await expect(promise).rejects.toMatchObject({ reason: "stale_evidence" });
    expect(w.api.all).toHaveLength(1);
  });
});

describe("12. the evidence hash is bound to the incident and the proposal", () => {
  it("refuses a hash taken from another incident that looks the same", async () => {
    const w = world();
    const other = w.ledger.createObligation({
      reference: "INV-2002", beneficiaryId: "ben-B", amountMinor: 99_900, currency: "USD", method: "LOCAL", reason: "goods_purchased",
    });
    const commander = commanderFor(w);
    const seenOnA = await commander.assess(w.obligation.id);
    const seenOnB = await commander.assess(other.id);

    expect(seenOnA.evidenceHash).not.toBe(seenOnB.evidenceHash);
    await expect(
      commander.humanApproval({ obligationId: other.id, approver: "cfo@acme.example", note: "supplier confirmed by phone callback", evidenceHash: seenOnA.evidenceHash }),
    ).rejects.toMatchObject({ name: "ApprovalRejected", reason: "stale_evidence" });
    expect(w.api.all).toHaveLength(0);
  });

  it("tells apart two incidents that are identical in every field except their id", async () => {
    // Same amount, currency, beneficiary, method, reason and status, and no attempts yet: only the id differs. Without
    // the id in the hash, an approval reviewed on one invoice would pass on the other.
    const w = world();
    const twin = w.ledger.createObligation({
      reference: "INV-1002", beneficiaryId: w.obligation.beneficiaryId, amountMinor: w.obligation.amountMinor, currency: w.obligation.currency,
      method: w.obligation.method, reason: w.obligation.reason,
    });
    const commander = commanderFor(w);
    const seenOnA = await commander.assess(w.obligation.id);
    const seenOnB = await commander.assess(twin.id);

    expect(seenOnA.evidenceHash).not.toBe(seenOnB.evidenceHash);
    await expect(
      commander.humanApproval({ obligationId: twin.id, approver: "cfo@acme.example", note: "supplier confirmed by phone callback", evidenceHash: seenOnA.evidenceHash }),
    ).rejects.toMatchObject({ name: "ApprovalRejected", reason: "stale_evidence" });
    expect(w.api.all).toHaveLength(0);
  });

  it("does not change merely because an hour passes while a transfer processes", async () => {
    const w = world();
    await w.gateway.submit(approve(w.obligation));
    let now = new Date();
    const commander = new Commander({ ledger: w.ledger, gateway: w.gateway, balances: w.api, secret: SECRET, now: () => now });

    const early = await commander.assess(w.obligation.id);
    now = new Date(now.getTime() + 3 * 3600_000);
    const later = await commander.assess(w.obligation.id);

    expect(later.decision.reasons).not.toEqual(early.decision.reasons); // the prose moved on ...
    expect(later.evidenceHash).toBe(early.evidenceHash); // ... the decision it is bound to did not
  });

  it("changes when the decision changes, or the terms it would propose", async () => {
    const w = world();
    const { attempt } = await w.gateway.submit(approve(w.obligation));
    const commander = commanderFor(w);
    const processing = await commander.assess(w.obligation.id);

    w.api.advance(attempt.transferId!, "FAILED", "91402");
    w.api.advance(attempt.transferId!, "CANCELLED", "91402");
    const cancelled = await commander.assess(w.obligation.id);
    w.ledger.db.query("UPDATE attempts SET beneficiaryId = 'ben-B' WHERE id = ?").run(attempt.id);
    const retargeted = await commander.assess(w.obligation.id);

    expect(cancelled.evidenceHash).not.toBe(processing.evidenceHash);
    expect(retargeted.evidenceHash).not.toBe(cancelled.evidenceHash);
  });
});

describe("13. a later record's statement credit cannot lift a non-receipt claim", () => {
  const record = (w: World, e: SupplierEvidence, source: "manual" | "model" = "model") =>
    w.ledger.append(w.obligation.id, "EVIDENCE_RECORDED", { evidence: e, source, enteredBy: source === "manual" ? "ap@acme.example" : "agent:test", message: null });
  const current = (w: World) => effectiveEvidence(w.ledger.events(w.obligation.id), w.obligation.amountMinor)?.evidence ?? null;
  const credit = (w: World) => ({ amountMinor: w.obligation.amountMinor, currency: "USD" });
  async function paidWorld(): Promise<World> {
    const w = world();
    const { attempt } = await w.gateway.submit(approve(w.obligation));
    w.api.advance(attempt.transferId!, "PAID");
    await w.gateway.sync();
    return w;
  }
  const commanderHeld = (w: World) =>
    new Commander({ ledger: w.ledger, gateway: w.gateway, balances: w.api, secret: SECRET, policy: { ...DEFAULT_POLICY, paidHoldMs: 0 } });

  it("keeps SEND_PROOF_TO_SUPPLIER when a model record brings a matching credit after a claim", async () => {
    const w = await paidWorld();
    record(w, evidence({ claimsNonReceipt: true }));
    expect((await commanderHeld(w).assess(w.obligation.id, current(w))).decision.recommended).toBe("SEND_PROOF_TO_SUPPLIER");

    record(w, evidence({ claimsNonReceipt: false, statementCredit: credit(w), summary: "spoofed statement" }));
    const { decision } = await commanderHeld(w).assess(w.obligation.id, current(w));

    expect(decision.recommended).toBe("SEND_PROOF_TO_SUPPLIER");
    expect(decision.allowed).not.toContain("CLOSE");
  });

  it("lets a manual record carry the credit that confirms receipt", async () => {
    const w = await paidWorld();
    record(w, evidence({ claimsNonReceipt: true }));
    record(w, evidence({ claimsNonReceipt: true, statementCredit: credit(w) }), "manual");

    const { decision } = await commanderHeld(w).assess(w.obligation.id, current(w));

    expect(decision.recommended).toBe("CLOSE");
  });

  it("withdraws that trust when a later record claims non-receipt again", async () => {
    const w = await paidWorld();
    record(w, evidence({ claimsNonReceipt: false, statementCredit: credit(w) }), "manual");
    expect((await commanderHeld(w).assess(w.obligation.id, current(w))).decision.recommended).toBe("CLOSE");

    record(w, evidence({ claimsNonReceipt: true }));
    expect((await commanderHeld(w).assess(w.obligation.id, current(w))).decision.recommended).toBe("SEND_PROOF_TO_SUPPLIER");
  });

  it("still treats a model-carried credit as a reason for caution when the transfer was cancelled", async () => {
    const w = world();
    await killedAttempt(w, "91402");
    record(w, evidence({ claimsNonReceipt: false, statementCredit: credit(w) }));

    const { decision } = await commanderFor(w).assess(w.obligation.id, current(w));

    expect(decision.recommended).toBe("ESCALATE");
  });
});
