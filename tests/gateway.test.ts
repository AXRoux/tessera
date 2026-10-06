import { describe, expect, it } from "bun:test";
import { newNonce, type ApprovalPayload } from "../src/approval/approval";
import { ApprovalRejected, DuplicateLockError, LedgerMismatchError, ReplacementDenied } from "../src/errors";
import { PayoutGateway } from "../src/gateway/gateway";
import { approve, killedAttempt, SECRET, world } from "./helpers/world";

describe("exactly-once payout", () => {
  it("creates one transfer and records the fee Airwallex reports", async () => {
    const { gateway, api, obligation, ledger } = world();

    const { outcome, attempt } = await gateway.submit(approve(obligation));

    expect(outcome).toBe("CREATED");
    expect(api.all).toHaveLength(1);
    expect(attempt.state).toBe("LIVE");
    expect(attempt.feeMinor).toBe(300);
    expect(attempt.payerPaysMinor).toBe(10_300);
    expect(ledger.requireObligation(obligation.id).status).toBe("PAYING");
  });

  it("lets only one of two concurrent submissions through", async () => {
    const { gateway, api, obligation } = world();

    const results = await Promise.allSettled([gateway.submit(approve(obligation)), gateway.submit(approve(obligation))]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(DuplicateLockError);
    expect(api.all).toHaveLength(1);
  });

  it("is enforced by the database even when the gateway is bypassed", () => {
    const { ledger, obligation } = world();
    const attempt = (seq: number) => ({
      obligationId: obligation.id, seq, requestId: `req-${seq}`, beneficiaryId: "ben-A", amountMinor: 10_000,
      currency: "USD", method: "LOCAL" as const, reason: "r", approvalNonce: `nonce-${seq}-xxxxxxxxxxxx`,
    });

    ledger.insertAttempt(attempt(1));

    expect(() => ledger.insertAttempt(attempt(2))).toThrow(DuplicateLockError);
  });

  it("rejects an approval that has already been spent", async () => {
    const { gateway, obligation } = world();
    const spent = approve(obligation);
    await gateway.submit(spent);

    await expect(gateway.submit(spent)).rejects.toMatchObject({ name: "ApprovalRejected", reason: "replayed" });
  });

  it("refuses an approval for a different amount than the obligation", async () => {
    const { gateway, api, obligation } = world();

    await expect(gateway.submit(approve(obligation, { amountMinor: 10_100 }))).rejects.toBeInstanceOf(ApprovalRejected);
    expect(api.all).toHaveLength(0);
  });
});

describe("ambiguous outcomes", () => {
  it("adopts the transfer by request_id when the create response is lost", async () => {
    const { gateway, api, obligation } = world();
    api.faults.loseResponseAfterCreate = 1;

    const { outcome, attempt } = await gateway.submit(approve(obligation));

    expect(outcome).toBe("ADOPTED_AFTER_AMBIGUITY");
    expect(attempt.transferId).toBe(api.all[0]!.id);
    expect(api.all).toHaveLength(1);
    expect(api.createCalls).toBe(1);
  });

  it("stays locked through an outage, then recovery adopts without sending a second create", async () => {
    const { gateway, api, obligation } = world();
    api.faults.loseResponseAfterCreate = 1;
    api.faults.failLookup = 1;

    const first = await gateway.submit(approve(obligation));
    expect(first.outcome).toBe("PENDING_RECOVERY");
    await expect(gateway.submit(approve(obligation))).rejects.toBeInstanceOf(DuplicateLockError);

    const [recovered] = await gateway.recover();

    expect(recovered!.outcome).toBe("ADOPTED_AFTER_AMBIGUITY");
    expect(api.all).toHaveLength(1);
    expect(api.createCalls).toBe(1);
  });

  it("re-sends the same request_id, never a new one, when the create never reached Airwallex", async () => {
    const { gateway, api, obligation } = world();
    api.faults.failBeforeCreate = 1;

    const first = await gateway.submit(approve(obligation));
    expect(first.outcome).toBe("PENDING_RECOVERY");
    expect(api.all).toHaveLength(0);

    const [recovered] = await gateway.recover();

    expect(recovered!.outcome).toBe("CREATED");
    expect(recovered!.attempt.requestId).toBe(first.attempt.requestId);
    expect(api.all).toHaveLength(1);
  });

  it("adopts the existing transfer when Airwallex answers duplicate_request_id", async () => {
    const { ledger, api, obligation } = world();
    const gateway = new PayoutGateway({ ledger, api, approvalSecret: SECRET, newRequestId: () => "req-fixed" });
    await api.createTransfer({
      request_id: "req-fixed", beneficiary_id: "ben-A", source_currency: "USD", transfer_currency: "USD",
      transfer_amount: 100, transfer_method: "LOCAL", reason: "professional_business_services", reference: "INV-1001",
    });

    const { outcome } = await gateway.submit(approve(obligation));

    expect(outcome).toBe("ADOPTED_DUPLICATE");
    expect(api.all).toHaveLength(1);
  });

  it("escalates instead of adopting a transfer that shares the request_id but not the terms", async () => {
    const { ledger, api, obligation } = world();
    const gateway = new PayoutGateway({ ledger, api, approvalSecret: SECRET, newRequestId: () => "req-fixed" });
    await api.createTransfer({
      request_id: "req-fixed", beneficiary_id: "ben-A", source_currency: "USD", transfer_currency: "USD",
      transfer_amount: 250, transfer_method: "LOCAL", reason: "professional_business_services", reference: "INV-1001",
    });

    await expect(gateway.submit(approve(obligation))).rejects.toBeInstanceOf(LedgerMismatchError);

    expect(ledger.requireObligation(obligation.id).status).toBe("ESCALATED");
    expect(ledger.latestAttempt(obligation.id)!.state).toBe("INTENT");
  });

  it("releases the lock when Airwallex definitively rejects the create, allowing a corrected retry", async () => {
    const { gateway, api, obligation, ledger } = world();
    api.faults.rejectCreate = 1;

    const rejected = await gateway.submit(approve(obligation));
    expect(rejected.outcome).toBe("REJECTED");
    expect(rejected.attempt.state).toBe("ABANDONED");
    expect(ledger.requireObligation(obligation.id).status).toBe("OPEN");

    const retry = await gateway.submit(approve(obligation, { replacesAttemptId: rejected.attempt.id }));

    expect(retry.outcome).toBe("CREATED");
    expect(retry.attempt.seq).toBe(2);
    expect(api.all).toHaveLength(1);
  });
});

describe("finality", () => {
  it("holds the lock through FAILED and releases it only at CANCELLED", async () => {
    const { gateway, api, obligation } = world();
    const { attempt } = await gateway.submit(approve(obligation));
    const replacement = () => gateway.submit(approve(obligation, { replacesAttemptId: attempt.id }));

    api.advance(attempt.transferId!, "SENT");
    await gateway.sync();
    await expect(replacement()).rejects.toBeInstanceOf(DuplicateLockError);

    api.advance(attempt.transferId!, "FAILED", "91401");
    await gateway.sync();
    await expect(replacement()).rejects.toBeInstanceOf(DuplicateLockError);

    api.advance(attempt.transferId!, "CANCELLED", "91401");
    await gateway.sync();
    const second = await replacement();

    expect(second.outcome).toBe("CREATED");
    expect(second.attempt.requestId).not.toBe(attempt.requestId);
    expect(api.all).toHaveLength(2);
  });

  it("treats PAID as non-final: it keeps the lock, and a later failure reopens the obligation", async () => {
    const { gateway, api, obligation, ledger } = world();
    const { attempt } = await gateway.submit(approve(obligation));

    api.advance(attempt.transferId!, "PAID");
    const [paid] = await gateway.sync();
    expect(paid!.state).toBe("PAID");
    expect(ledger.requireObligation(obligation.id).status).toBe("PAID");
    await expect(gateway.submit(approve(obligation, { replacesAttemptId: attempt.id }))).rejects.toBeInstanceOf(DuplicateLockError);

    api.advance(attempt.transferId!, "FAILED", "90802");
    api.advance(attempt.transferId!, "CANCELLED", "90802");
    const [dead] = await gateway.sync();

    expect(dead!.state).toBe("DEAD");
    expect(ledger.requireObligation(obligation.id).status).toBe("NEEDS_ACTION");
    expect(ledger.events(obligation.id).map((e) => e.type)).toContain("LATE_FAILURE");
  });

  it("keeps the lock for a status it does not recognize", async () => {
    const { gateway, api, obligation } = world();
    const { attempt } = await gateway.submit(approve(obligation));

    api.advance(attempt.transferId!, "QUANTUM_SUPERPOSITION");
    const [after] = await gateway.sync();

    expect(after!.state).toBe("LIVE");
    await expect(gateway.submit(approve(obligation, { replacesAttemptId: attempt.id }))).rejects.toBeInstanceOf(DuplicateLockError);
  });
});

describe("replacement policy", () => {
  it("replaces automatically after a transient failure", async () => {
    const w = world();
    const dead = await killedAttempt(w, "91402");

    const { outcome } = await w.gateway.submit(approve(w.obligation, { replacesAttemptId: dead.id }));

    expect(outcome).toBe("CREATED");
  });

  it("refuses to replace a possible duplicate without a human who explains why", async () => {
    const w = world();
    const dead = await killedAttempt(w, "91301");
    const replace = (overrides: Partial<ApprovalPayload>) =>
      w.gateway.submit(approve(w.obligation, { replacesAttemptId: dead.id, ...overrides }));

    await expect(replace({})).rejects.toBeInstanceOf(ReplacementDenied);
    await expect(replace({ mode: "HUMAN", approver: "ops@acme" })).rejects.toBeInstanceOf(ReplacementDenied);
    await expect(replace({ mode: "HUMAN", approver: "ops@acme", note: "short" })).rejects.toBeInstanceOf(ReplacementDenied);
    expect(w.api.all).toHaveLength(1);

    const { outcome } = await replace({ mode: "HUMAN", approver: "ops@acme", note: "supplier bank confirmed non-receipt by phone" });
    expect(outcome).toBe("CREATED");
  });

  it("requires a changed beneficiary after the account details were rejected", async () => {
    const w = world();
    const dead = await killedAttempt(w, "90101");

    await expect(w.gateway.submit(approve(w.obligation, { replacesAttemptId: dead.id }))).rejects.toBeInstanceOf(ReplacementDenied);

    const { outcome, attempt } = await w.gateway.submit(
      approve(w.obligation, { replacesAttemptId: dead.id, beneficiaryId: "ben-B" }),
    );
    expect(outcome).toBe("CREATED");
    expect(attempt.beneficiaryId).toBe("ben-B");
    expect(w.ledger.requireObligation(w.obligation.id).beneficiaryId).toBe("ben-B");
  });

  it("requires a changed payment purpose after the purpose was rejected", async () => {
    const w = world();
    const dead = await killedAttempt(w, "91101");

    await expect(w.gateway.submit(approve(w.obligation, { replacesAttemptId: dead.id }))).rejects.toBeInstanceOf(ReplacementDenied);
    const { outcome } = await w.gateway.submit(approve(w.obligation, { replacesAttemptId: dead.id, reason: "goods_purchased" }));

    expect(outcome).toBe("CREATED");
  });

  it("fails closed on a failure code it has never seen", async () => {
    const w = world();
    const dead = await killedAttempt(w, "12345");

    await expect(w.gateway.submit(approve(w.obligation, { replacesAttemptId: dead.id }))).rejects.toBeInstanceOf(ReplacementDenied);
  });

  it("rejects an approval that names the wrong attempt to replace", async () => {
    const w = world();
    await killedAttempt(w, "91402");

    await expect(
      w.gateway.submit(approve(w.obligation, { replacesAttemptId: "not-the-latest-attempt", nonce: newNonce() })),
    ).rejects.toMatchObject({ name: "ApprovalRejected", reason: "stale" });
  });

  it("requires a human before paying an escalated obligation", async () => {
    const w = world();
    const dead = await killedAttempt(w, "91402");
    w.ledger.escalate(w.obligation.id, "supplier emailed new bank details");

    await expect(w.gateway.submit(approve(w.obligation, { replacesAttemptId: dead.id }))).rejects.toMatchObject({
      name: "ObligationNotPayable",
    });
    const { outcome } = await w.gateway.submit(
      approve(w.obligation, { replacesAttemptId: dead.id, mode: "HUMAN", approver: "cfo@acme", note: "verified by callback" }),
    );
    expect(outcome).toBe("CREATED");
  });
});
