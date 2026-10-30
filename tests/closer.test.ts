import { describe, expect, it } from "bun:test";
import { FakePayoutApi } from "../src/airwallex/fake";
import { verifyCertificate } from "../src/closer/signing";
import { Closer } from "../src/closer/closer";
import { NotClosable, ObligationNotPayable } from "../src/errors";
import { PayoutGateway } from "../src/gateway/gateway";
import { fakeHttp } from "./helpers/fake-fetch";
import { approve, SECRET, world, type World } from "./helpers/world";

function closerFor(w: World, options: { paidHoldMs?: number; now?: () => Date } = {}): Closer {
  return new Closer({ ledger: w.ledger, api: w.api, gateway: w.gateway, secret: SECRET, paidHoldMs: 0, ...options });
}

/** Pays the obligation and drives the transfer to PAID. */
async function paid(w: World): Promise<string> {
  const { attempt } = await w.gateway.submit(approve(w.obligation));
  w.api.advance(attempt.transferId!, "SENT");
  w.api.advance(attempt.transferId!, "PAID");
  await w.gateway.sync(w.obligation.id);
  return attempt.id;
}

async function blockersOf(closer: Closer, w: World): Promise<string[]> {
  const error = await closer.close(w.obligation.id).catch((e: unknown) => e);
  if (!(error instanceof NotClosable)) throw new Error(`expected NotClosable, got ${String(error)}`);
  return error.blockers;
}

describe("closing an incident", () => {
  it("certifies a clean payment, and the certificate verifies", async () => {
    const w = world();
    await paid(w);

    const certificate = await closerFor(w).close(w.obligation.id);

    expect(verifyCertificate(certificate, SECRET)).toBe(true);
    expect(certificate.body.totals).toEqual({ paidMinor: 10_000, feesMinor: 300, refundedMinor: 0, netWalletMinor: -10_300 });
    expect(w.ledger.requireObligation(w.obligation.id).status).toBe("CLOSED");
  });

  it("returns the original certificate when closed twice, and records one CLOSED event", async () => {
    const w = world();
    await paid(w);
    const closer = closerFor(w);

    const first = await closer.close(w.obligation.id);
    const second = await closer.close(w.obligation.id);

    expect(second).toEqual(first);
    expect(w.ledger.events(w.obligation.id).filter((e) => e.type === "CLOSED")).toHaveLength(1);
  });

  it("stops the gateway from paying a closed obligation", async () => {
    const w = world();
    const attemptId = await paid(w);
    await closerFor(w).close(w.obligation.id);

    await expect(w.gateway.submit(approve(w.obligation, { replacesAttemptId: attemptId }))).rejects.toBeInstanceOf(ObligationNotPayable);
  });

  it("counts the fee the returned attempt kept: paid once, fees twice", async () => {
    const w = world();
    const firstId = await paid(w);
    const first = w.ledger.requireAttempt(firstId);
    w.api.advance(first.transferId!, "FAILED", "90802");
    w.api.advance(first.transferId!, "CANCELLED", "90802");
    await w.gateway.sync(w.obligation.id);
    const replacement = await w.gateway.submit(
      approve(w.obligation, { replacesAttemptId: firstId, mode: "HUMAN", approver: "ops@acme", note: "supplier confirmed account by callback" }),
    );
    w.api.advance(replacement.attempt.transferId!, "PAID");
    await w.gateway.sync(w.obligation.id);

    const certificate = await closerFor(w).close(w.obligation.id);

    expect(certificate.body.totals).toEqual({ paidMinor: 10_000, feesMinor: 600, refundedMinor: 10_000, netWalletMinor: -10_600 });
    expect(certificate.body.attempts.map((a) => a.state)).toEqual(["DEAD", "PAID"]);
  });

  it("returns one certificate when two closes race", async () => {
    const w = world();
    await paid(w);

    const [a, b] = await Promise.all([closerFor(w).close(w.obligation.id), closerFor(w).close(w.obligation.id)]);

    expect(a).toEqual(b);
    expect(w.ledger.events(w.obligation.id).filter((e) => e.type === "CLOSED")).toHaveLength(1);
  });

  it("records Airwallex's status for the settled transfer in the certificate", async () => {
    const w = world();
    await paid(w);

    const certificate = await closerFor(w).close(w.obligation.id);

    expect(certificate.body.settledAwxStatus).toBe("PAID");
    expect(certificate.body.attempts[0]!.awxStatus).toBe("PAID");
  });
});

describe("after a certified payment fails late", () => {
  it("revokes the certificate and escalates; once a person resolves it and the replacement pays, a fresh close succeeds", async () => {
    const w = world();
    const firstId = await paid(w);
    const original = await closerFor(w).close(w.obligation.id);
    const transferId = w.ledger.requireAttempt(firstId).transferId!;
    w.api.advance(transferId, "FAILED", "90802");
    w.api.advance(transferId, "CANCELLED", "90802");

    await w.gateway.syncTransfer(transferId);

    expect(w.ledger.getCertificateJson(w.obligation.id)).toBeNull();
    expect(w.ledger.requireObligation(w.obligation.id).status).toBe("ESCALATED");
    expect(w.ledger.events(w.obligation.id).map((e) => e.type)).toContain("CERTIFICATE_REVOKED");
    expect(w.ledger.verifyChain().ok).toBe(true);
    await expect(closerFor(w).close(w.obligation.id)).rejects.toBeInstanceOf(NotClosable);
    expect(w.ledger.resolveEscalation(w.obligation.id, "ops@acme", "bank returned the payment; supplier re-verified").status).toBe("NEEDS_ACTION");

    const replacement = await w.gateway.submit(
      approve(w.obligation, { replacesAttemptId: firstId, mode: "HUMAN", approver: "ops@acme", note: "supplier confirmed new account by callback" }),
    );
    w.api.advance(replacement.attempt.transferId!, "PAID");

    const fresh = await closerFor(w).close(w.obligation.id);

    expect(fresh.hash).not.toBe(original.hash);
    expect(fresh.body.settledAttemptId).toBe(replacement.attempt.id);
    expect(w.ledger.requireObligation(w.obligation.id).status).toBe("CLOSED");
    expect(w.ledger.verifyChain().ok).toBe(true);
  });
});

describe("configuration", () => {
  it("refuses a hold window that is not a finite, non-negative number", () => {
    const w = world();

    for (const paidHoldMs of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(() => closerFor(w, { paidHoldMs })).toThrow("paidHoldMs");
    }
  });
});

describe("refusing to close", () => {
  it("when Airwallex now says FAILED though the ledger last saw PAID", async () => {
    const w = world();
    const attemptId = await paid(w);
    w.api.advance(w.ledger.requireAttempt(attemptId).transferId!, "FAILED", "90802");

    const blockers = await blockersOf(closerFor(w), w);

    expect(blockers).toContain("expected exactly one PAID attempt, found 0");
    expect(w.ledger.requireAttempt(attemptId).awxStatus).toBe("FAILED");
    expect(w.ledger.events(w.obligation.id).map((e) => e.type)).toContain("LATE_FAILURE");
  });

  it("when a wallet line is in another currency than the obligation", async () => {
    const w = world();
    const attemptId = await paid(w);
    const transfer = w.api.transfers.get(w.ledger.requireAttempt(attemptId).transferId!)!;
    w.api.book({ ...transfer, transfer_currency: "EUR" }, "FEE", -1);

    const blockers = await blockersOf(closerFor(w), w);

    expect(blockers.some((b) => b.includes("FEE -1 EUR") && b.includes("same-currency"))).toBe(true);
  });

  it("when someone else paid this reference and the transfer is past the first page of Airwallex's results", async () => {
    const w = world();
    const api = new FakePayoutApi({ pageSize: 1 });
    const gateway = new PayoutGateway({ ledger: w.ledger, api, approvalSecret: SECRET });
    const { attempt } = await gateway.submit(approve(w.obligation));
    api.advance(attempt.transferId!, "PAID");
    const rogue = await api.createTransfer({
      request_id: "rogue-request", beneficiary_id: "ben-A", source_currency: "USD", transfer_currency: "USD",
      transfer_amount: 100, transfer_method: "LOCAL", reason: "professional_business_services", reference: w.obligation.reference,
    });
    const http = fakeHttp(api);
    const closer = new Closer({ ledger: w.ledger, api: http.client, gateway, secret: SECRET, paidHoldMs: 0 });

    const error = await closer.close(w.obligation.id).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotClosable);
    expect((error as NotClosable).blockers).toContain(`transfer ${rogue.id} carries this reference but is not in the ledger`);
    expect(http.calls.filter((c) => c.startsWith("GET /api/v1/transfers?"))).toHaveLength(2);
  });

  it("while the replacement is still processing", async () => {
    const w = world();
    const firstId = await paid(w);
    const first = w.ledger.requireAttempt(firstId);
    w.api.advance(first.transferId!, "FAILED", "91402");
    w.api.advance(first.transferId!, "CANCELLED", "91402");
    await w.gateway.sync(w.obligation.id);
    await w.gateway.submit(approve(w.obligation, { replacesAttemptId: firstId }));

    const blockers = await blockersOf(closerFor(w), w);

    expect(blockers).toContain("attempt #2: still LIVE; not final");
    expect(blockers).toContain("expected exactly one PAID attempt, found 0");
  });

  it("when a paid transfer is returned and no replacement has paid", async () => {
    const w = world();
    const attemptId = await paid(w);
    const attempt = w.ledger.requireAttempt(attemptId);
    w.api.advance(attempt.transferId!, "FAILED", "90802");
    w.api.advance(attempt.transferId!, "CANCELLED", "90802");
    await w.gateway.sync(w.obligation.id);

    expect(await blockersOf(closerFor(w), w)).toEqual(["expected exactly one PAID attempt, found 0"]);
  });

  it("when the wallet was debited twice for one transfer", async () => {
    const w = world();
    const attemptId = await paid(w);
    const transfer = w.api.transfers.get(w.ledger.requireAttempt(attemptId).transferId!)!;
    w.api.book(transfer, "PAYOUT", -10_000 / 100);

    const blockers = await blockersOf(closerFor(w), w);

    expect(blockers).toContain("attempt #1: payoutMinor is -20000 at Airwallex, ledger expects -10000");
    expect(blockers).toContain("the wallet shows 20000 minor units left for the supplier, but 10000 are owed");
  });

  it("when someone else already paid this reference outside the ledger", async () => {
    const w = world();
    await paid(w);
    const rogue = await w.api.createTransfer({
      request_id: "rogue-request", beneficiary_id: "ben-A", source_currency: "USD", transfer_currency: "USD",
      transfer_amount: 100, transfer_method: "LOCAL", reason: "professional_business_services", reference: w.obligation.reference,
    });

    const blockers = await blockersOf(closerFor(w), w);

    expect(blockers).toContain(`transfer ${rogue.id} carries this reference but is not in the ledger`);
  });

  it("while wallet lines are still pending", async () => {
    const w = world();
    const attemptId = await paid(w);
    const transferId = w.ledger.requireAttempt(attemptId).transferId!;
    w.api.wallet.get(transferId)![0]!.status = "PENDING";

    expect(await blockersOf(closerFor(w), w)).toContain("attempt #1: 1 wallet line(s) still pending");
  });

  it("inside the hold window after PAID, then allows it once the window passes", async () => {
    const w = world();
    await paid(w);
    const hold = 60 * 60_000;

    const early = await blockersOf(closerFor(w, { paidHoldMs: hold }), w);
    expect(early.some((b) => b.startsWith("PAID is not final"))).toBe(true);

    const later = closerFor(w, { paidHoldMs: hold, now: () => new Date(Date.now() + hold + 60_000) });
    await expect(later.close(w.obligation.id)).resolves.toBeDefined();
  });

  it("when the obligation is escalated", async () => {
    const w = world();
    await paid(w);
    w.ledger.escalate(w.obligation.id, "supplier disputes the amount");

    expect(await blockersOf(closerFor(w), w)).toContain("obligation is escalated: supplier disputes the amount");
  });

  it("when the event history was tampered with", async () => {
    const w = world();
    await paid(w);
    const target = w.ledger.events().find((e) => e.type === "ATTEMPT_INTENT")!;
    w.ledger.db.query("UPDATE events SET payload = ? WHERE seq = ?").run('{"edited":true}', target.seq);

    expect(await blockersOf(closerFor(w), w)).toContain(`event chain is broken: event ${target.seq} was altered`);
  });
});

describe("certificate integrity", () => {
  it("rejects a certificate whose amount was edited", async () => {
    const w = world();
    await paid(w);
    const certificate = await closerFor(w).close(w.obligation.id);

    const edited = { ...certificate, body: { ...certificate.body, amountMinor: 1 } };

    expect(verifyCertificate(edited, SECRET)).toBe(false);
  });

  it("rejects a certificate checked with another secret", async () => {
    const w = world();
    await paid(w);
    const certificate = await closerFor(w).close(w.obligation.id);

    expect(verifyCertificate(certificate, "another-secret-another-secret-another")).toBe(false);
  });

  it("breaks the chain check when a stored certificate is swapped for one pinned to another history", async () => {
    const w = world();
    await paid(w);
    const certificate = await closerFor(w).close(w.obligation.id);
    const forged = { ...certificate, body: { ...certificate.body, eventChainHead: "f".repeat(64) } };

    w.ledger.db.query("UPDATE certificates SET json = ? WHERE obligationId = ?").run(JSON.stringify(forged), w.obligation.id);

    expect(w.ledger.verifyChain()).toMatchObject({ ok: false, reason: expect.stringContaining("certificate") });
  });
});
