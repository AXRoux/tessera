import { describe, expect, it } from "bun:test";
import { FakePayoutApi } from "../src/airwallex/fake";
import { AwxHttpError, type CreateTransferRequest, type PayoutApi, type Transfer } from "../src/airwallex/types";
import { Closer } from "../src/closer/closer";
import { ApprovalRejected, DuplicateLockError, LedgerMismatchError, StateConflict } from "../src/errors";
import { PayoutGateway } from "../src/gateway/gateway";
import { Ledger } from "../src/ledger/ledger";
import { approve, SECRET, world, type World } from "./helpers/world";

const NOTE = "checked the Airwallex dashboard with the supplier on the phone";
const OPS = "ops@acme";

const eventsOf = (w: { ledger: Ledger; obligation: { id: string } }, type: string) =>
  w.ledger.events(w.obligation.id).filter((e) => e.type === type);

/** A transfer made straight at the fake, as a send that was still in flight would. */
const sendLate = (api: FakePayoutApi, requestId: string, overrides: Partial<CreateTransferRequest> = {}) =>
  api.createTransfer({
    request_id: requestId, beneficiary_id: "ben-A", source_currency: "USD", transfer_currency: "USD",
    transfer_amount: 100, transfer_method: "LOCAL", reason: "professional_business_services", reference: "INV-1001", ...overrides,
  });

describe("1. a released INTENT never leaves a live sender", () => {
  it("(a) a release during the Retry-After sleep ends with exactly one transfer", async () => {
    const w = world();
    const asleep = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    const sleep = () => { reached.resolve(); return asleep.promise; };
    const gateway = new PayoutGateway({ ledger: w.ledger, api: w.api, approvalSecret: SECRET, sleep, minIntentReleaseAgeMs: 0 });
    w.api.faults.rateLimitCreate = 1;

    const first = gateway.submit(approve(w.obligation)); // INTENT written, 429 received, now asleep
    const outcome = first.then((r) => r, (e: unknown) => e);
    await reached.promise;
    const intent = w.ledger.latestAttempt(w.obligation.id)!;
    expect(intent.state).toBe("INTENT");
    await gateway.resolveAttempt({ attemptId: intent.id, by: OPS, note: NOTE });
    const replacement = await gateway.submit(approve(w.obligation, { replacesAttemptId: intent.id }));
    asleep.resolve();

    expect(await outcome).toBeInstanceOf(StateConflict);
    expect(replacement.outcome).toBe("CREATED");
    expect(w.api.all).toHaveLength(1);
    expect(w.api.all[0]!.request_id).toBe(replacement.attempt.requestId);
    expect(w.ledger.verifyChain().ok).toBe(true);
  });

  it("(a) a send already in flight when the intent is released lands as a recorded orphan, never a silent second payment", async () => {
    const w = world();
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const slow: PayoutApi = {
      createTransfer: async (request) => { entered.resolve(); await gate.promise; return w.api.createTransfer(request); },
      getTransfer: (id) => w.api.getTransfer(id),
      findTransferByRequestId: (requestId, from) => w.api.findTransferByRequestId(requestId, from),
    };
    const sender = new PayoutGateway({ ledger: w.ledger, api: slow, approvalSecret: SECRET });
    const operator = new PayoutGateway({ ledger: w.ledger, api: w.api, approvalSecret: SECRET, minIntentReleaseAgeMs: 0 });

    const inFlight = sender.submit(approve(w.obligation));
    const outcome = inFlight.then((r) => r, (e: unknown) => e);
    await entered.promise; // the POST is out
    const intent = w.ledger.latestAttempt(w.obligation.id)!;
    await operator.resolveAttempt({ attemptId: intent.id, by: OPS, note: NOTE });
    await operator.submit(approve(w.obligation, { replacesAttemptId: intent.id }));
    gate.resolve();

    expect(await outcome).toBeInstanceOf(StateConflict);
    expect(w.api.all).toHaveLength(2); // the orphan could not be stopped, but it is on the record
    const orphans = eventsOf(w, "TRANSFER_AFTER_ABANDON");
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.payload).toMatchObject({ attemptId: intent.id });
    expect(w.ledger.requireObligation(w.obligation.id).status).toBe("ESCALATED");
    expect(w.ledger.requireAttempt(intent.id).state).toBe("ABANDONED");
    expect(w.ledger.verifyChain().ok).toBe(true);
  });

  it("(a) the re-read also stops a resend when another process already adopted the attempt", async () => {
    const w = world();
    w.api.faults.rateLimitCreate = 1;
    const other = new PayoutGateway({ ledger: w.ledger, api: w.api, approvalSecret: SECRET });
    const sender = new PayoutGateway({
      ledger: w.ledger, api: w.api, approvalSecret: SECRET,
      sleep: async () => {
        // While the sender slept, a lost-response transfer for this request_id was found by someone else.
        const intent = w.ledger.latestAttempt(w.obligation.id)!;
        await sendLate(w.api, intent.requestId);
        await other.recover();
      },
    });

    const result = await sender.submit(approve(w.obligation));

    expect(result.outcome).toBe("ADOPTED_AFTER_AMBIGUITY");
    expect(w.api.all).toHaveLength(1);
    expect(w.api.createCalls).toBe(2); // the 429, then the late one: the sender never sent again
  });

  it("(b) refuses to release a young INTENT that Airwallex has no transfer for; allows it once old enough", async () => {
    const w = world();
    let now = new Date();
    const gateway = new PayoutGateway({ ledger: w.ledger, api: w.api, approvalSecret: SECRET, now: () => now, sleep: async () => undefined });
    w.api.faults.rateLimitCreate = 10;
    const { attempt } = await gateway.submit(approve(w.obligation));
    expect(attempt.state).toBe("INTENT");

    await expect(gateway.resolveAttempt({ attemptId: attempt.id, by: OPS, note: NOTE })).rejects.toThrow(/may still be in flight/);
    expect(w.ledger.requireAttempt(attempt.id).state).toBe("INTENT");

    now = new Date(Date.now() + 11 * 60_000);
    const released = await gateway.resolveAttempt({ attemptId: attempt.id, by: OPS, note: NOTE });

    expect(released.state).toBe("ABANDONED");
  });

  it("(b) an intent already marked stale is exempt from the age floor", async () => {
    const w = world();
    let now = new Date();
    const gateway = new PayoutGateway({ ledger: w.ledger, api: w.api, approvalSecret: SECRET, now: () => now, minIntentReleaseAgeMs: 3 * 24 * 3600_000 });
    w.api.faults.failBeforeCreate = 1;
    const { attempt } = await gateway.submit(approve(w.obligation));
    now = new Date(Date.now() + 25 * 3600_000);
    await gateway.recover(); // writes INTENT_STALE

    expect((await gateway.resolveAttempt({ attemptId: attempt.id, by: OPS, note: NOTE })).state).toBe("ABANDONED");
  });

  it("(c) a transfer that appears for an ABANDONED attempt is recorded once, escalated once, and never throws", async () => {
    const w = world();
    const gateway = new PayoutGateway({ ledger: w.ledger, api: w.api, approvalSecret: SECRET, minIntentReleaseAgeMs: 0 });
    w.api.faults.failBeforeCreate = 1;
    const { attempt } = await gateway.submit(approve(w.obligation));
    await gateway.resolveAttempt({ attemptId: attempt.id, by: OPS, note: NOTE });
    // The release leaves the obligation OPEN: nothing was escalated before the orphan appears.
    expect(w.ledger.requireObligation(w.obligation.id).status).toBe("OPEN");
    const late = await sendLate(w.api, attempt.requestId);

    const first = await gateway.syncTransfer(late.id);
    const second = await gateway.syncTransfer(late.id);

    expect(first!.state).toBe("ABANDONED");
    expect(second!.state).toBe("ABANDONED");
    expect(eventsOf(w, "TRANSFER_AFTER_ABANDON")).toHaveLength(1);
    expect(eventsOf(w, "ESCALATED")).toHaveLength(1);
    expect(w.ledger.requireObligation(w.obligation.id).status).toBe("ESCALATED");
    expect(w.ledger.verifyChain().ok).toBe(true);
  });

  it("(c) the orphan of a closed obligation withdraws its certificate", async () => {
    const w = world();
    const gateway = new PayoutGateway({ ledger: w.ledger, api: w.api, approvalSecret: SECRET, minIntentReleaseAgeMs: 0 });
    w.api.faults.failBeforeCreate = 1;
    const stuck = (await gateway.submit(approve(w.obligation))).attempt;
    await gateway.resolveAttempt({ attemptId: stuck.id, by: OPS, note: NOTE });
    const paid = await gateway.submit(approve(w.obligation, { replacesAttemptId: stuck.id }));
    w.api.advance(paid.attempt.transferId!, "PAID");
    await gateway.sync();
    await new Closer({ ledger: w.ledger, api: w.api, gateway, secret: SECRET, paidHoldMs: 0 }).close(w.obligation.id);
    expect(w.ledger.getCertificateJson(w.obligation.id)).not.toBeNull();

    const late = await sendLate(w.api, stuck.requestId);
    await gateway.syncTransfer(late.id);

    expect(w.ledger.getCertificateJson(w.obligation.id)).toBeNull();
    expect(eventsOf(w, "CERTIFICATE_REVOKED")).toHaveLength(1);
    expect(w.ledger.requireObligation(w.obligation.id).status).toBe("ESCALATED");
    expect(w.ledger.verifyChain().ok).toBe(true);
  });

  it("(d) looks a request_id up from before the intent, so a transfer older than Airwallex's 30-day default window is still found", async () => {
    const ledger = new Ledger(":memory:");
    let now = new Date();
    const api = new FakePayoutApi({ now: () => now });
    const gateway = new PayoutGateway({ ledger, api, approvalSecret: SECRET, now: () => now });
    const obligation = ledger.createObligation({
      reference: "INV-1001", beneficiaryId: "ben-A", amountMinor: 10_000, currency: "USD", method: "LOCAL", reason: "professional_business_services",
    });
    api.faults.loseResponseAfterCreate = 1;
    api.faults.failLookup = 1;
    const { attempt } = await gateway.submit(approve(obligation));
    expect(attempt.state).toBe("INTENT");
    now = new Date(Date.now() + 40 * 24 * 3600_000);

    await expect(gateway.resolveAttempt({ attemptId: attempt.id, by: OPS, note: NOTE })).rejects.toBeInstanceOf(StateConflict);

    expect(ledger.requireAttempt(attempt.id)).toMatchObject({ state: "LIVE", transferId: api.all[0]!.id });
    const reached = Date.parse(api.lookups.at(-1)!.fromCreatedAt!);
    expect(reached).toBeLessThanOrEqual(Date.parse(attempt.createdAt));
    expect(api.all).toHaveLength(1);
  });
});

describe("2. approval states are resumable, so they do not free the lock", () => {
  it("never ends with two PAID transfers undetected", async () => {
    const w = world();
    const { attempt } = await w.gateway.submit(approve(w.obligation));
    w.api.advance(attempt.transferId!, "APPROVAL_REJECTED");
    await w.gateway.sync();

    await expect(w.gateway.resolveAttempt({ attemptId: attempt.id, by: OPS, note: "rejected in the approval queue" })).rejects.toBeInstanceOf(StateConflict);
    const replacement = approve(w.obligation, { replacesAttemptId: attempt.id, mode: "HUMAN", approver: OPS, note: "pay it again, the old one was rejected" });
    await expect(w.gateway.submit(replacement)).rejects.toBeInstanceOf(DuplicateLockError);
    for (const status of ["IN_APPROVAL", "PROCESSING", "PAID"]) w.api.advance(attempt.transferId!, status);
    await w.gateway.sync();

    expect(w.api.all).toHaveLength(1);
    expect(w.ledger.requireAttempt(attempt.id)).toMatchObject({ state: "PAID", awxStatus: "PAID" });
    expect(w.ledger.verifyChain().ok).toBe(true);
  });

  /** What an older build did: released the approval-held attempt to DEAD. */
  function releasedByOlderBuild(w: World, attemptId: string): void {
    w.ledger.tx(() => {
      w.ledger.updateAttempt(attemptId, { state: "DEAD" });
      w.ledger.append(w.obligation.id, "ATTEMPT_RESOLVED", { attemptId, by: OPS, note: NOTE, from: "LIVE", to: "DEAD" });
      w.ledger.refreshObligationStatus(w.obligation.id);
    });
  }

  it("keeps polling a transfer an older build released from an approval state, and escalates once when it resumes", async () => {
    const w = world();
    const { attempt } = await w.gateway.submit(approve(w.obligation));
    w.api.advance(attempt.transferId!, "APPROVAL_REJECTED");
    await w.gateway.sync();
    releasedByOlderBuild(w, attempt.id);
    expect(w.ledger.verifyChain().ok).toBe(true);
    const replacement = await w.gateway.submit(
      approve(w.obligation, { replacesAttemptId: attempt.id, mode: "HUMAN", approver: OPS, note: "pay it again, the old one was rejected" }),
    );

    w.api.advance(attempt.transferId!, "IN_APPROVAL");
    await w.gateway.sync();
    await w.gateway.sync(); // the same status again: nothing new is written
    expect(eventsOf(w, "STATUS_AFTER_DEAD")).toHaveLength(1);
    expect(eventsOf(w, "ESCALATED")).toHaveLength(1);
    w.api.advance(attempt.transferId!, "PROCESSING");
    w.api.advance(attempt.transferId!, "PAID");
    w.api.advance(replacement.attempt.transferId!, "PAID");
    await w.gateway.sync();

    expect(w.api.all.filter((t) => t.status === "PAID")).toHaveLength(2); // Airwallex paid twice ...
    expect(w.ledger.requireObligation(w.obligation.id).status).toBe("ESCALATED"); // ... and the ledger knows
    expect(eventsOf(w, "STATUS_AFTER_DEAD")).toHaveLength(2); // each new status is recorded once
    expect(w.ledger.verifyChain().ok).toBe(true);
  });

  it("stops polling a released approval-state transfer once Airwallex cancels it", async () => {
    const w = world();
    const { attempt } = await w.gateway.submit(approve(w.obligation));
    w.api.advance(attempt.transferId!, "APPROVAL_BLOCKED");
    await w.gateway.sync();
    releasedByOlderBuild(w, attempt.id);
    expect(w.ledger.syncableAttempts()).toHaveLength(1);

    w.api.advance(attempt.transferId!, "CANCELLED");
    await w.gateway.sync();

    expect(w.ledger.syncableAttempts()).toHaveLength(0);
    expect(w.ledger.requireAttempt(attempt.id)).toMatchObject({ state: "DEAD", awxStatus: "CANCELLED" });
    expect(w.ledger.requireObligation(w.obligation.id).status).not.toBe("ESCALATED");
    expect(w.ledger.verifyChain().ok).toBe(true);
  });

  it("will not release on a CANCELLED snapshot older than what is stored (the stale one is dropped, so the stored status must still match)", async () => {
    const w = world();
    const { attempt } = await w.gateway.submit(approve(w.obligation));
    w.api.advance(attempt.transferId!, "SENT");
    await w.gateway.sync();
    const stale = { ...(await w.api.getTransfer(attempt.transferId!)), status: "CANCELLED", updated_at: new Date(Date.now() - 3600_000).toISOString() };
    const lying: PayoutApi = {
      createTransfer: (request) => w.api.createTransfer(request),
      getTransfer: async () => structuredClone(stale),
      findTransferByRequestId: (requestId, from) => w.api.findTransferByRequestId(requestId, from),
    };

    await expect(
      new PayoutGateway({ ledger: w.ledger, api: lying, approvalSecret: SECRET }).resolveAttempt({ attemptId: attempt.id, by: OPS, note: NOTE }),
    ).rejects.toBeInstanceOf(StateConflict);

    expect(w.ledger.requireAttempt(attempt.id)).toMatchObject({ state: "LIVE", awxStatus: "SENT" });
  });
});

describe("5. an escalated obligation is never sent for", () => {
  it("recover() looks the request_id up but does not POST a left-behind INTENT", async () => {
    const w = world();
    w.api.faults.failBeforeCreate = 1;
    const first = await w.gateway.submit(approve(w.obligation));
    expect(first.outcome).toBe("PENDING_RECOVERY");
    w.ledger.escalate(w.obligation.id, "supplier says the account changed");

    const [result] = await w.gateway.recover();

    expect(result!.outcome).toBe("PENDING_RECOVERY");
    expect(w.api.all).toHaveLength(0);
    expect(w.api.createCalls).toBe(1);
    expect(w.ledger.requireAttempt(first.attempt.id).state).toBe("INTENT");
    expect(w.api.lookups.length).toBeGreaterThan(0);
  });

  it("still adopts a transfer that already exists for the request_id", async () => {
    const w = world();
    w.api.faults.loseResponseAfterCreate = 1;
    w.api.faults.failLookup = 1;
    const first = await w.gateway.submit(approve(w.obligation));
    w.ledger.escalate(w.obligation.id, "supplier says the account changed");

    const [result] = await w.gateway.recover();

    expect(result!.outcome).toBe("ADOPTED_AFTER_AMBIGUITY");
    expect(w.ledger.requireAttempt(first.attempt.id).state).toBe("LIVE");
    expect(w.api.createCalls).toBe(1);
  });

  it("a human-approved payment on an escalated obligation is still sent (the approval clears the escalation)", async () => {
    const w = world();
    const dead = await (async () => {
      const { attempt } = await w.gateway.submit(approve(w.obligation));
      w.api.advance(attempt.transferId!, "CANCELLED", "91402");
      return (await w.gateway.sync())[0]!;
    })();
    w.ledger.escalate(w.obligation.id, "supplier emailed");

    const result = await w.gateway.submit(approve(w.obligation, { replacesAttemptId: dead.id, mode: "HUMAN", approver: OPS, note: "verified by callback" }));

    expect(result.outcome).toBe("CREATED");
  });
});

describe("8. a mismatching transfer is escalated once and starves nothing", () => {
  async function twoObligations() {
    const w = world();
    const second = w.ledger.createObligation({
      reference: "INV-1002", beneficiaryId: "ben-A", amountMinor: 5_000, currency: "USD", method: "LOCAL", reason: "professional_business_services",
    });
    const a = await w.gateway.submit(approve(w.obligation));
    const b = await w.gateway.submit(approve(second));
    return { w, second, a: a.attempt, b: b.attempt };
  }

  it("sync adopts the healthy obligation even though the first one mismatches, and escalates once over three sweeps", async () => {
    const { w, second, a, b } = await twoObligations();
    w.api.transfers.get(a.transferId!)!.transfer_amount = 250; // Airwallex now shows a different amount
    w.api.advance(b.transferId!, "SENT");

    await w.gateway.sync();
    await w.gateway.sync();
    await w.gateway.sync();

    expect(w.ledger.requireAttempt(b.id).awxStatus).toBe("SENT");
    expect(w.ledger.requireObligation(second.id).status).toBe("PAYING");
    expect(eventsOf(w, "ESCALATED")).toHaveLength(1);
    expect(eventsOf(w, "TRANSFER_MISMATCH")).toHaveLength(1);
    expect(w.ledger.requireObligation(w.obligation.id).status).toBe("ESCALATED");
    expect(w.ledger.verifyChain().ok).toBe(true);
  });

  it("recover skips a mismatched INTENT without throwing, and still resolves the next one", async () => {
    const w = world();
    const second = w.ledger.createObligation({
      reference: "INV-1002", beneficiaryId: "ben-A", amountMinor: 5_000, currency: "USD", method: "LOCAL", reason: "professional_business_services",
    });
    w.api.faults.failBeforeCreate = 2;
    const a = (await w.gateway.submit(approve(w.obligation))).attempt;
    const b = (await w.gateway.submit(approve(second))).attempt;
    await sendLate(w.api, a.requestId, { transfer_amount: 250 }); // a transfer under a's request_id with other terms

    const results = await w.gateway.recover();

    expect(results).toHaveLength(2);
    expect(w.ledger.requireAttempt(b.id).state).toBe("LIVE");
    expect(w.ledger.requireAttempt(a.id).state).toBe("INTENT");
    expect(w.ledger.requireObligation(w.obligation.id).status).toBe("ESCALATED");
    await w.gateway.recover();
    await w.gateway.recover();
    expect(eventsOf(w, "TRANSFER_MISMATCH")).toHaveLength(1);
  });

  it("a mismatched INTENT can be released by a person; the transfer is recorded as an orphan", async () => {
    const w = world();
    const gateway = new PayoutGateway({ ledger: w.ledger, api: w.api, approvalSecret: SECRET });
    w.api.faults.failBeforeCreate = 1;
    const a = (await gateway.submit(approve(w.obligation))).attempt;
    const odd = await sendLate(w.api, a.requestId, { transfer_amount: 250 });
    await expect(gateway.submit(approve(w.obligation))).rejects.toBeInstanceOf(DuplicateLockError);

    const released = await gateway.resolveAttempt({ attemptId: a.id, by: OPS, note: NOTE });

    expect(released.state).toBe("ABANDONED");
    expect(eventsOf(w, "TRANSFER_AFTER_ABANDON")[0]!.payload).toMatchObject({ transferId: odd.id });
    expect(w.ledger.requireObligation(w.obligation.id).status).toBe("ESCALATED");
    expect(w.ledger.verifyChain().ok).toBe(true);
  });

  it("the submit that meets the mismatch still raises it, after writing it once", async () => {
    const w = world();
    const gateway = new PayoutGateway({ ledger: w.ledger, api: w.api, approvalSecret: SECRET, newRequestId: () => "req-fixed" });
    await sendLate(w.api, "req-fixed", { transfer_amount: 250 });

    await expect(gateway.submit(approve(w.obligation))).rejects.toBeInstanceOf(LedgerMismatchError);
    await expect(gateway.recover()).resolves.toHaveLength(1);

    expect(eventsOf(w, "TRANSFER_MISMATCH")).toHaveLength(1);
  });
});

describe("9. whole-second updated_at cannot roll a PAID back", () => {
  it("a late SENT in the same second does not undo PAID, add LATE_FAILURE or revoke the certificate", async () => {
    const fixed = new Date("2026-03-01T12:00:00.400Z");
    const w = world();
    const api = new FakePayoutApi({ now: () => fixed, secondResolution: true });
    const gateway = new PayoutGateway({ ledger: w.ledger, api, approvalSecret: SECRET });
    const { attempt } = await gateway.submit(approve(w.obligation));
    api.advance(attempt.transferId!, "SENT");
    const sent = await api.getTransfer(attempt.transferId!);
    api.advance(attempt.transferId!, "PAID");
    await gateway.sync();
    await new Closer({ ledger: w.ledger, api, gateway, secret: SECRET, paidHoldMs: 0 }).close(w.obligation.id);
    const paidSnapshot = await api.getTransfer(attempt.transferId!);
    expect(sent.updated_at).toBe(paidSnapshot.updated_at); // the same second

    const slow: PayoutApi = {
      createTransfer: (request) => api.createTransfer(request),
      getTransfer: async () => structuredClone(sent),
      findTransferByRequestId: (requestId, from) => api.findTransferByRequestId(requestId, from),
    };
    await new PayoutGateway({ ledger: w.ledger, api: slow, approvalSecret: SECRET }).sync();

    expect(w.ledger.requireAttempt(attempt.id)).toMatchObject({ state: "PAID", awxStatus: "PAID" });
    expect(eventsOf(w, "LATE_FAILURE")).toHaveLength(0);
    expect(eventsOf(w, "CERTIFICATE_REVOKED")).toHaveLength(0);
    expect(w.ledger.requireObligation(w.obligation.id).status).toBe("CLOSED");
    expect(w.ledger.getCertificateJson(w.obligation.id)).not.toBeNull();
  });

  it("still applies a later status that is further along, even within the same second", async () => {
    const fixed = new Date("2026-03-01T12:00:00.400Z");
    const w = world();
    const api = new FakePayoutApi({ now: () => fixed, secondResolution: true });
    const gateway = new PayoutGateway({ ledger: w.ledger, api, approvalSecret: SECRET });
    const { attempt } = await gateway.submit(approve(w.obligation));
    api.advance(attempt.transferId!, "SENT");
    await gateway.sync();
    api.advance(attempt.transferId!, "PAID");

    await gateway.sync();

    expect(w.ledger.requireAttempt(attempt.id).state).toBe("PAID");
  });
});

describe("10. abandon is a compare-and-set, and a re-send's 4xx is an ambiguity", () => {
  it("a definitive-looking 4xx cannot abandon an attempt another process already adopted", async () => {
    const w = world();
    const other = new PayoutGateway({ ledger: w.ledger, api: w.api, approvalSecret: SECRET });
    const racing: PayoutApi = {
      createTransfer: async (request) => {
        await w.api.createTransfer(request); // the transfer landed (an earlier send)
        await other.recover(); // another process looked it up and adopted it
        throw new AwxHttpError(400, "validation_failed", "schema validation failed", { code: "validation_failed" });
      },
      getTransfer: (id) => w.api.getTransfer(id),
      findTransferByRequestId: (requestId, from) => w.api.findTransferByRequestId(requestId, from),
    };
    const sender = new PayoutGateway({ ledger: w.ledger, api: racing, approvalSecret: SECRET });

    const result = await sender.submit(approve(w.obligation));

    expect(result.attempt.state).toBe("LIVE");
    expect(result.outcome).not.toBe("REJECTED");
    expect(eventsOf(w, "ATTEMPT_ABANDONED")).toHaveLength(0);
    expect(w.ledger.requireAttempt(result.attempt.id)).toMatchObject({ state: "LIVE", transferId: w.api.all[0]!.id });
    expect(w.ledger.verifyChain().ok).toBe(true);
  });

  it("a 4xx on a RE-SEND from recover() is looked up, not taken as rejection", async () => {
    const w = world();
    w.api.faults.failBeforeCreate = 1;
    const first = await w.gateway.submit(approve(w.obligation));
    w.api.faults.rejectCreate = 1;

    const [result] = await w.gateway.recover();

    expect(result!.outcome).toBe("PENDING_RECOVERY");
    expect(w.ledger.requireAttempt(first.attempt.id).state).toBe("INTENT");
    expect(eventsOf(w, "ATTEMPT_ABANDONED")).toHaveLength(0);
    const [again] = await w.gateway.recover(); // the lock held, and the next re-send succeeds
    expect(again!.outcome).toBe("CREATED");
  });
});

describe("11. a person may correct the terms after Airwallex refused every request", () => {
  async function rejectedOnce() {
    const w = world();
    w.api.faults.rejectCreate = 1;
    const rejected = await w.gateway.submit(approve(w.obligation));
    expect(rejected.outcome).toBe("REJECTED");
    return { w, rejected: rejected.attempt };
  }

  it("a human approval with a written note may change the beneficiary", async () => {
    const { w, rejected } = await rejectedOnce();

    const result = await w.gateway.submit(
      approve(w.obligation, { replacesAttemptId: rejected.id, beneficiaryId: "ben-B", mode: "HUMAN", approver: OPS, note: "ben-A was refused; ben-B is the correct account" }),
    );

    expect(result.outcome).toBe("CREATED");
    expect(result.attempt.beneficiaryId).toBe("ben-B");
    expect(w.ledger.requireObligation(w.obligation.id).beneficiaryId).toBe("ben-B");
    expect(w.ledger.verifyChain().ok).toBe(true);
  });

  it("a policy approval may not, and neither may a human without a written note", async () => {
    const { w, rejected } = await rejectedOnce();

    await expect(w.gateway.submit(approve(w.obligation, { replacesAttemptId: rejected.id, beneficiaryId: "ben-B" }))).rejects.toMatchObject({
      name: "ApprovalRejected", reason: "terms_mismatch",
    });
    await expect(
      w.gateway.submit(approve(w.obligation, { replacesAttemptId: rejected.id, beneficiaryId: "ben-B", mode: "HUMAN", approver: OPS, note: "short" })),
    ).rejects.toBeInstanceOf(ApprovalRejected);
    expect(w.api.all).toHaveLength(0);
  });

  it("a first attempt, with nothing behind it, still must use the obligation's own terms even for a human", async () => {
    const w = world();

    await expect(
      w.gateway.submit(approve(w.obligation, { beneficiaryId: "ben-B", mode: "HUMAN", approver: OPS, note: "pay the other account please" })),
    ).rejects.toMatchObject({ reason: "terms_mismatch" });
  });
});

describe("16. the 429 loop", () => {
  it("waits a real backoff even when Airwallex says Retry-After: 0", async () => {
    const w = world();
    const waits: number[] = [];
    const gateway = new PayoutGateway({ ledger: w.ledger, api: w.api, approvalSecret: SECRET, sleep: async (ms) => void waits.push(ms) });
    w.api.rateLimitRetryAfterMs = 0;
    w.api.faults.rateLimitCreate = 3;

    const { outcome } = await gateway.submit(approve(w.obligation));

    expect(outcome).toBe("CREATED");
    expect(waits).toHaveLength(3);
    expect(waits.every((ms) => ms >= 250)).toBe(true);
    expect(waits[1]!).toBeGreaterThan(waits[0]!);
  });

  it("still honours a longer Retry-After, capped", async () => {
    const w = world();
    const waits: number[] = [];
    const gateway = new PayoutGateway({ ledger: w.ledger, api: w.api, approvalSecret: SECRET, sleep: async (ms) => void waits.push(ms) });
    w.api.rateLimitRetryAfterMs = 5 * 60_000;
    w.api.faults.rateLimitCreate = 1;

    await gateway.submit(approve(w.obligation));

    expect(waits).toEqual([30_000]);
  });

  it("records CREATE_AMBIGUOUS once per distinct error, not once per sweep", async () => {
    const w = world();
    const gateway = new PayoutGateway({ ledger: w.ledger, api: w.api, approvalSecret: SECRET, sleep: async () => undefined });
    w.api.faults.rateLimitCreate = 100;
    await gateway.submit(approve(w.obligation));

    await gateway.recover();
    await gateway.recover();
    await gateway.recover();

    expect(eventsOf(w, "CREATE_AMBIGUOUS")).toHaveLength(1);

    w.api.faults.rateLimitCreate = 0;
    w.api.faults.failBeforeCreate = 1; // a different error: recorded
    await gateway.recover();
    expect(eventsOf(w, "CREATE_AMBIGUOUS")).toHaveLength(2);
  });
});

