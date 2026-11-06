import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakePayoutApi } from "../src/airwallex/fake";
import { Closer } from "../src/closer/closer";
import { Commander } from "../src/commander/commander";
import { ApprovalRejected, StateConflict } from "../src/errors";
import { PayoutGateway } from "../src/gateway/gateway";
import { Ledger } from "../src/ledger/ledger";
import { approve, killedAttempt, SECRET, world, type World } from "./helpers/world";
import { fundingApproval, fundWorld } from "./helpers/fund-world";

const NOTE = "checked the Airwallex dashboard with the supplier on the phone";
const OPS = "ops@acme";
const tempDb = (): string => join(mkdtempSync(join(tmpdir(), "tessera-verify-")), "ledger.db");
const commanderFor = (w: World) => new Commander({ ledger: w.ledger, gateway: w.gateway, balances: w.api, secret: SECRET });
const newObligation = (ledger: Ledger, reference: string, amountMinor = 5_000) =>
  ledger.createObligation({ reference, beneficiaryId: "ben-A", amountMinor, currency: "USD", method: "LOCAL", reason: "professional_business_services" });

describe("3. a deleted attempt row is detected", () => {
  it("fails verification and refuses the next payment when a LIVE attempt row is deleted", async () => {
    const w = world();
    const { attempt } = await w.gateway.submit(approve(w.obligation));

    w.ledger.db.query("DELETE FROM attempts WHERE id = ?").run(attempt.id);

    expect(w.ledger.verifyChain()).toMatchObject({ ok: false, reason: expect.stringContaining("missing from the attempts table") });
    await expect(w.gateway.submit(approve(w.obligation))).rejects.toMatchObject({
      name: "ObligationNotPayable", message: expect.stringContaining("ledger does not verify"),
    });
    expect(w.api.all).toHaveLength(1);
  });

  it("fails when an obligation row is deleted", () => {
    const { ledger, obligation } = world();

    ledger.db.query("DELETE FROM obligations WHERE id = ?").run(obligation.id);

    expect(ledger.verifyChain()).toMatchObject({ ok: false, reason: expect.stringContaining("missing from the obligations table") });
  });
});

describe("4. attempt and obligation columns are verified against their events", () => {
  it("catches failureCode 91301 edited to 91402, and the replacement is refused", async () => {
    const w = world();
    const dead = await killedAttempt(w, "91301");
    expect(w.ledger.verifyChain().ok).toBe(true);

    w.ledger.db.query("UPDATE attempts SET failureCode = '91402' WHERE id = ?").run(dead.id);

    expect(w.ledger.verifyChain()).toMatchObject({ ok: false, reason: expect.stringContaining("failureCode") });
    await expect(commanderFor(w).replaceAutomatically(w.obligation.id)).rejects.toThrow();
    expect(w.api.all).toHaveLength(1);
  });

  it("catches attempts.beneficiaryId edited, and the policy replacement is refused", async () => {
    const w = world();
    const dead = await killedAttempt(w, "91402");

    w.ledger.db.query("UPDATE attempts SET beneficiaryId = 'ben-B' WHERE id = ?").run(dead.id);

    expect(w.ledger.verifyChain()).toMatchObject({ ok: false, reason: expect.stringContaining("beneficiaryId") });
    await expect(commanderFor(w).replaceAutomatically(w.obligation.id)).rejects.toThrow();
    expect(w.api.all).toHaveLength(1);
  });

  it.each([
    ["amountMinor", "UPDATE attempts SET amountMinor = 99999 WHERE id = ?"],
    ["currency", "UPDATE attempts SET currency = 'EUR' WHERE id = ?"],
    ["method", "UPDATE attempts SET method = 'SWIFT' WHERE id = ?"],
    ["reason", "UPDATE attempts SET reason = 'goods_purchased' WHERE id = ?"],
    ["requestId", "UPDATE attempts SET requestId = 'forged-request-id' WHERE id = ?"],
  ])("catches attempts.%s edited", async (field, sql) => {
    const w = world();
    const { attempt } = await w.gateway.submit(approve(w.obligation));

    w.ledger.db.query(sql).run(attempt.id);

    expect(w.ledger.verifyChain()).toMatchObject({ ok: false, reason: expect.stringContaining(field) });
  });

  it("catches obligations.amountMinor edited, and the payment is refused", async () => {
    const w = world();
    const dead = await killedAttempt(w, "91402");

    w.ledger.db.query("UPDATE obligations SET amountMinor = 20000 WHERE id = ?").run(w.obligation.id);

    expect(w.ledger.verifyChain()).toMatchObject({ ok: false, reason: expect.stringContaining("amountMinor") });
    await expect(w.gateway.submit(approve(w.obligation, { amountMinor: 20_000, replacesAttemptId: dead.id }))).rejects.toMatchObject({
      name: "ObligationNotPayable",
    });
    expect(w.api.all).toHaveLength(1);
  });

  it.each([
    ["beneficiaryId", "UPDATE obligations SET beneficiaryId = 'ben-B' WHERE id = ?"],
    ["method", "UPDATE obligations SET method = 'SWIFT' WHERE id = ?"],
    ["reason", "UPDATE obligations SET reason = 'goods_purchased' WHERE id = ?"],
    ["currency", "UPDATE obligations SET currency = 'EUR' WHERE id = ?"],
  ])("catches obligations.%s edited", async (field, sql) => {
    const w = world();
    await killedAttempt(w, "91402");

    w.ledger.db.query(sql).run(w.obligation.id);

    expect(w.ledger.verifyChain()).toMatchObject({ ok: false, reason: expect.stringContaining(field) });
  });

  it("follows the obligation's terms when a person corrects them: no false positive", async () => {
    const w = world();
    w.api.faults.rejectCreate = 1;
    const rejected = await w.gateway.submit(approve(w.obligation));
    await w.gateway.submit(
      approve(w.obligation, { replacesAttemptId: rejected.attempt.id, beneficiaryId: "ben-B", mode: "HUMAN", approver: OPS, note: "ben-A was refused; ben-B is right" }),
    );

    expect(w.ledger.verifyChain().ok).toBe(true);
  });

  it("does not report a false positive when adopt sets failureCode on a snapshot whose status did not change", async () => {
    const w = world();
    const { attempt } = await w.gateway.submit(approve(w.obligation));
    w.api.advance(attempt.transferId!, "FAILED"); // FAILED, no failure detail yet
    await w.gateway.sync();
    expect(w.ledger.requireAttempt(attempt.id).failureCode).toBeNull();

    w.api.transfers.get(attempt.transferId!)!.failure = { code: "91402", message: "bank temporarily unavailable" }; // same status, same updated_at
    await w.gateway.sync();

    expect(w.ledger.requireAttempt(attempt.id).failureCode).toBe("91402");
    expect(w.ledger.events(w.obligation.id).filter((e) => e.type === "FAILURE_RECORDED")).toHaveLength(1);
    expect(w.ledger.verifyChain().ok).toBe(true);
    w.ledger.db.query("UPDATE attempts SET failureCode = '91301' WHERE id = ?").run(attempt.id);
    expect(w.ledger.verifyChain().ok).toBe(false);
  });

  it("still verifies a ledger written before terms and failure codes were recorded", () => {
    const ledger = new Ledger(":memory:");
    const o = newObligation(ledger, "INV-OLD");
    const attempt = ledger.insertAttempt({
      obligationId: o.id, seq: 1, requestId: "req-old", beneficiaryId: "ben-A", amountMinor: 5_000, currency: "USD", method: "LOCAL",
      reason: "professional_business_services", approvalNonce: "nonce-old-xxxxxxxxxxxx",
    });
    // The intent as an older build wrote it: no `terms`, no `failuresRecorded`.
    ledger.append(o.id, "ATTEMPT_INTENT", { attemptId: attempt.id, seq: 1, requestId: "req-old", replaces: null, mode: "POLICY", nonce: attempt.approvalNonce });
    ledger.updateAttempt(attempt.id, { state: "LIVE", transferId: "tr-old", awxStatus: "FAILED", failureCode: "91402" });
    ledger.append(o.id, "TRANSFER_STATUS", { attemptId: attempt.id, transferId: "tr-old", from: null, to: "FAILED", via: "sync", failureCode: null });

    expect(ledger.verifyChain().ok).toBe(true); // the failure code was set without an event, and it is not compared
    ledger.append(o.id, "FAILURE_RECORDED", { attemptId: attempt.id, transferId: "tr-old", failureCode: "91402" });
    expect(ledger.verifyChain().ok).toBe(true);
    ledger.db.query("UPDATE attempts SET failureCode = '91301' WHERE id = ?").run(attempt.id);
    expect(ledger.verifyChain().ok).toBe(false); // once an event vouches for it, it is compared
  });
});

describe("6. verifyChain reads one consistent snapshot", () => {
  it("never reports a false failure while another process appends to the same file", async () => {
    const path = tempDb();
    const reader = new Ledger(path);
    const worker = join(import.meta.dir, "helpers", "append-worker.ts");
    const child = Bun.spawn([process.execPath, worker, path, "400", "w"], { stderr: "pipe" });
    let finished = false;
    void child.exited.then(() => { finished = true; });

    let verified = 0;
    const failures: string[] = [];
    while (!finished) {
      const result = reader.verifyChain();
      verified++;
      if (!result.ok) failures.push(result.reason);
      const turn = Promise.withResolvers<void>();
      setImmediate(turn.resolve);
      await turn.promise;
    }

    expect(await new Response(child.stderr).text()).toBe("");
    expect(verified).toBeGreaterThan(1);
    expect(failures).toEqual([]);
    expect(reader.verifyChain().ok).toBe(true);
    expect(reader.events()).toHaveLength(400);
    reader.close();
  }, 30_000);
});

describe("7. migration and re-baseline", () => {
  it("several processes opening an old-format file at once end with one pinned chain", async () => {
    const path = tempDb();
    const old = new Ledger(path);
    const o = newObligation(old, "INV-OLD");
    for (let i = 0; i < 5; i++) old.append(o.id, "NOTE", { n: i });
    old.db.exec("DROP TABLE chain_head");
    old.close();

    const worker = join(import.meta.dir, "helpers", "open-worker.ts");
    const children = ["a", "b", "c", "d"].map((tag) => Bun.spawn([process.execPath, worker, path, "40", tag], { stderr: "pipe" }));
    const codes = await Promise.all(children.map((child) => child.exited));
    const errors = await Promise.all(children.map((child) => new Response(child.stderr).text()));

    expect({ codes, errors }).toEqual({ codes: [0, 0, 0, 0], errors: ["", "", "", ""] });
    const ledger = new Ledger(path);
    expect(ledger.events()).toHaveLength(6 + 160);
    expect(ledger.verifyChain().ok).toBe(true);
    ledger.close();
  }, 30_000);

  it("pins the chain head in the same transaction that creates it", () => {
    const path = tempDb();
    const old = new Ledger(path);
    const o = newObligation(old, "INV-OLD");
    old.append(o.id, "NOTE", {});
    old.db.exec("DROP TABLE chain_head");
    old.close();

    const reopened = new Ledger(path);

    expect(reopened.db.query("SELECT count FROM chain_head WHERE id = 1").get()).toEqual({ count: 2 });
    reopened.close();
  });

  function oldBuildFile(): Ledger {
    const ledger = new Ledger(tempDb());
    const o = newObligation(ledger, "INV-OLD");
    ledger.append(o.id, "NOTE", { n: 1 });
    const behind = ledger.db.query("SELECT hash, count FROM chain_head WHERE id = 1").get() as { hash: string; count: number };
    ledger.append(o.id, "NOTE", { n: 2 }); // an older build wrote these without keeping chain_head
    ledger.append(o.id, "NOTE", { n: 3 });
    ledger.db.query("UPDATE chain_head SET hash = ?, count = ? WHERE id = 1").run(behind.hash, behind.count);
    return ledger;
  }

  it("detects events written without chain_head upkeep, and an operator re-baseline makes the file verify again on the record", () => {
    const ledger = oldBuildFile();
    expect(ledger.verifyChain()).toMatchObject({ ok: false, reason: expect.stringContaining("events were written") });

    expect(() => ledger.rebaselineChain(OPS, "short")).toThrow(ApprovalRejected);
    expect(() => ledger.rebaselineChain("", NOTE)).toThrow(ApprovalRejected);
    expect(ledger.verifyChain().ok).toBe(false);

    const result = ledger.rebaselineChain(OPS, "older build wrote three events without chain_head; reviewed them");

    expect(result).toMatchObject({ ok: true, rebaselinedAt: expect.any(String) });
    const rebaseline = ledger.events().filter((e) => e.type === "CHAIN_REBASELINED");
    expect(rebaseline).toHaveLength(1);
    expect(rebaseline[0]!.payload).toMatchObject({ by: OPS, eventsBefore: 4, recordedHead: { count: 2 } });
    ledger.append(null, "NOTE", {});
    expect(ledger.verifyChain()).toMatchObject({ ok: true, rebaselinedAt: rebaseline[0]!.ts });
  });

  it("refuses to re-baseline a chain that is already pinned, or one whose events were altered", () => {
    const healthy = new Ledger(":memory:");
    newObligation(healthy, "INV-1");
    expect(() => healthy.rebaselineChain(OPS, NOTE)).toThrow(StateConflict);

    const tampered = oldBuildFile();
    tampered.db.query("UPDATE events SET payload = '{\"n\":99}' WHERE seq = 2").run();
    expect(() => tampered.rebaselineChain(OPS, NOTE)).toThrow(StateConflict);
    expect(tampered.verifyChain().ok).toBe(false);
  });

  it("is not reachable from the agent toolbox", async () => {
    const source = await Bun.file(join(import.meta.dir, "..", "src", "agent", "toolbox.ts")).text();
    expect(source).not.toContain("rebaseline");
  });
});

describe("verifyChain on every legitimate history the gateway writes", () => {
  it("stays ok after every step of a full lifecycle", async () => {
    const ledger = new Ledger(":memory:");
    const api = new FakePayoutApi();
    const gateway = new PayoutGateway({ ledger, api, approvalSecret: SECRET, minIntentReleaseAgeMs: 0 });
    const closer = new Closer({ ledger, api, gateway, secret: SECRET, paidHoldMs: 0 });
    const commander = new Commander({ ledger, gateway, balances: api, secret: SECRET });
    const ok = (step: string) => expect({ step, chain: ledger.verifyChain() }).toMatchObject({ chain: { ok: true } });

    // O1: abandoned, retried, unknown status, PAID, closed, late failure + revoke, escalation resolved, replaced, closed again.
    const o1 = ledger.createObligation({
      reference: "INV-1", beneficiaryId: "ben-A", amountMinor: 10_000, currency: "USD", method: "LOCAL", reason: "professional_business_services",
    });
    ok("created");
    api.faults.rejectCreate = 1;
    const abandoned = await gateway.submit(approve(o1));
    expect(abandoned.outcome).toBe("REJECTED");
    ok("abandoned");
    const retried = await gateway.submit(approve(o1, { replacesAttemptId: abandoned.attempt.id }));
    ok("retried");
    api.advance(retried.attempt.transferId!, "QUANTUM_SUPERPOSITION");
    await gateway.sync();
    ok("unknown status");
    api.advance(retried.attempt.transferId!, "SENT");
    api.advance(retried.attempt.transferId!, "PAID");
    await gateway.sync();
    ok("PAID");
    await closer.close(o1.id);
    ok("closed");
    api.advance(retried.attempt.transferId!, "FAILED", "91402");
    api.advance(retried.attempt.transferId!, "CANCELLED", "91402");
    await gateway.sync();
    expect(ledger.events(o1.id).map((e) => e.type)).toContain("CERTIFICATE_REVOKED");
    ok("late failure + revoke");
    ledger.resolveEscalation(o1.id, OPS, NOTE);
    ok("escalation resolved");
    const replaced = await commander.replaceAutomatically(o1.id);
    ok("replaced after cancel");
    api.advance(replaced.attempt.transferId!, "PAID");
    await gateway.sync();
    await closer.close(o1.id);
    ok("closed again");

    // O2: an INTENT a person released, then a transfer that lands for it anyway.
    const o2 = newObligation(ledger, "INV-2");
    api.faults.failBeforeCreate = 1;
    const stuck = await gateway.submit(approve(o2, { amountMinor: 5_000 }));
    ok("intent left behind");
    await gateway.resolveAttempt({ attemptId: stuck.attempt.id, by: OPS, note: NOTE });
    ok("released INTENT");
    const late = await api.createTransfer({
      request_id: stuck.attempt.requestId, beneficiary_id: "ben-A", source_currency: "USD", transfer_currency: "USD",
      transfer_amount: 50, transfer_method: "LOCAL", reason: "professional_business_services", reference: "INV-2",
    });
    await gateway.syncTransfer(late.id);
    ok("orphan recorded");

    // O3: an approval-held transfer a person releases once Airwallex cancels it; a failure code without a status change.
    const o3 = newObligation(ledger, "INV-3");
    const held = await gateway.submit(approve(o3, { amountMinor: 5_000 }));
    api.advance(held.attempt.transferId!, "APPROVAL_REJECTED");
    await gateway.sync();
    ok("released APPROVAL_* is still LIVE");
    await expect(gateway.resolveAttempt({ attemptId: held.attempt.id, by: OPS, note: NOTE })).rejects.toBeInstanceOf(StateConflict);
    ok("release refused");
    api.advance(held.attempt.transferId!, "CANCELLED", "91402");
    await gateway.resolveAttempt({ attemptId: held.attempt.id, by: OPS, note: NOTE });
    ok("released after CANCELLED");

    // O4: older build released an approval-held transfer, which then resumes.
    const o4 = newObligation(ledger, "INV-4");
    const legacy = await gateway.submit(approve(o4, { amountMinor: 5_000 }));
    api.advance(legacy.attempt.transferId!, "APPROVAL_BLOCKED");
    await gateway.sync();
    ledger.tx(() => {
      ledger.updateAttempt(legacy.attempt.id, { state: "DEAD" });
      ledger.append(o4.id, "ATTEMPT_RESOLVED", { attemptId: legacy.attempt.id, by: OPS, note: NOTE, from: "LIVE", to: "DEAD" });
      ledger.refreshObligationStatus(o4.id);
    });
    ok("legacy release");
    api.advance(legacy.attempt.transferId!, "IN_APPROVAL");
    await gateway.sync();
    ok("legacy transfer resumed");
    api.advance(legacy.attempt.transferId!, "CANCELLED");
    await gateway.sync();
    ok("legacy transfer cancelled");

    // O5: a mismatching transfer, and a person releasing its INTENT.
    const o5 = newObligation(ledger, "INV-5");
    api.faults.failBeforeCreate = 1;
    const odd = await gateway.submit(approve(o5, { amountMinor: 5_000 }));
    await api.createTransfer({
      request_id: odd.attempt.requestId, beneficiary_id: "ben-A", source_currency: "USD", transfer_currency: "USD",
      transfer_amount: 7, transfer_method: "LOCAL", reason: "professional_business_services", reference: "INV-5",
    });
    await gateway.recover();
    await gateway.recover();
    ok("mismatch");
    await gateway.resolveAttempt({ attemptId: odd.attempt.id, by: OPS, note: NOTE });
    ok("mismatched INTENT released");
    ledger.resolveEscalation(o5.id, OPS, NOTE);
    ok("escalation resolved again");

    // O6: failure code arriving on an unchanged status; a PAID that stays PAID against a stale snapshot.
    const o6 = newObligation(ledger, "INV-6");
    const quiet = await gateway.submit(approve(o6, { amountMinor: 5_000 }));
    api.advance(quiet.attempt.transferId!, "FAILED");
    await gateway.sync();
    api.transfers.get(quiet.attempt.transferId!)!.failure = { code: "91402", message: "later detail" };
    await gateway.sync();
    ok("failure code on an unchanged status");
    api.advance(quiet.attempt.transferId!, "CANCELLED", "91402");
    await gateway.sync();
    ok("cancelled");
    expect(ledger.listObligations()).toHaveLength(6);
  });
});

describe("8. conversion rows are verified against their events", () => {
  it("catches a conversion's sell amount edited, and the replacement it funded is refused", async () => {
    const w = await fundWorld();
    const { result } = await w.commander.fundAutomatically(w.obligation.id);
    expect(w.ledger.verifyChain().ok).toBe(true);

    w.ledger.db.query("UPDATE conversions SET sellMinor = sellMinor - 100 WHERE id = ?").run(result.conversion.id);

    expect(w.ledger.verifyChain()).toMatchObject({ ok: false, reason: expect.stringContaining(`conversion ${result.conversion.id}`) });
    await expect(w.commander.replaceAutomatically(w.obligation.id)).rejects.toThrow();
    expect(w.api.all).toHaveLength(1);
  });

  it("catches a settled conversion row deleted, which would otherwise free the lock for a second conversion", async () => {
    const w = await fundWorld();
    const { result } = await w.commander.fundAutomatically(w.obligation.id);

    w.ledger.db.query("DELETE FROM conversions WHERE id = ?").run(result.conversion.id);

    expect(w.ledger.verifyChain()).toMatchObject({ ok: false, reason: expect.stringContaining("missing from the conversions table") });
    await expect(w.executor.book(await fundingApproval(w))).rejects.toMatchObject({ name: "ObligationNotPayable" });
    expect(w.api.conversions.size).toBe(1);
  });

  it("catches a conversion row with no FUNDING_INTENT behind it", async () => {
    const w = await fundWorld();

    w.ledger.insertConversion({
      obligationId: w.obligation.id, forAttemptId: w.dead.id, requestId: "req-forged", approvalNonce: "n".repeat(32), quoteId: "q-forged",
      currencyPair: "EURUSD", buyCurrency: "EUR", buyMinor: 2_666, sellCurrency: "USD", sellMinor: 3_015, rate: 1.130824, quoteValidTo: new Date().toISOString(),
    });

    expect(w.ledger.verifyChain()).toMatchObject({ ok: false, reason: expect.stringContaining("has no FUNDING_INTENT event") });
  });

  it("stays ok through a whole funded lifecycle: ambiguous send, recovery, replacement, close", async () => {
    const w = await fundWorld();
    w.api.faults.loseConversionResponse = 1;
    w.api.faults.failConversionLookup = 1;
    await w.commander.fundAutomatically(w.obligation.id).catch(() => null);
    expect(w.ledger.verifyChain().ok).toBe(true);
    await w.commander.recoverFunding();
    const { attempt } = await w.commander.replaceAutomatically(w.obligation.id);
    w.api.advance(attempt.transferId!, "SENT");
    w.api.advance(attempt.transferId!, "PAID");
    await w.gateway.sync();
    await w.closer.close(w.obligation.id);

    expect(w.ledger.verifyChain().ok).toBe(true);
  });
});
