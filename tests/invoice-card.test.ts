import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolbox, type ToolOutcome } from "../src/agent/toolbox";
import { issueApproval, newNonce } from "../src/approval/approval";
import { SANDBOX_MERCHANT_ORIGIN, SandboxMerchant } from "../src/cards/merchant";
import { agentKeyFrom, newNonce as tapNonce, signObject, signRequest } from "../src/cards/tap";
import { effectiveEvidence } from "../src/commander/evidence";
import { decide, type IncidentFacts } from "../src/commander/policy";
import { seedIncident, type IncidentKind } from "../src/demo/scenario";
import { DuplicateLockError } from "../src/errors";
import { Ledger, type Attempt } from "../src/ledger/ledger";
import { buildRuntime, OFFLINE_BENEFICIARIES } from "../src/server/runtime";

const OPERATOR = "operator:dana@acme.example";
const SIGN_NOTE = "Supplier confirmed by phone; card payment for this invoice approved.";

/** The offline runtime (simulated Airwallex, Issuing and the TAP merchant), with one incident of each kind asked for. */
async function offline(kinds: IncidentKind[], env: Record<string, string> = {}) {
  const runtime = buildRuntime({ TESSERA_OFFLINE: "1", TESSERA_PAID_HOLD_MS: "0", ...env });
  const deps = { ledger: runtime.ledger, gateway: runtime.gateway, commander: runtime.commander, simulator: runtime.simulator! };
  const ids: Record<string, string> = {};
  for (const [i, kind] of kinds.entries()) {
    const seeded = await seedIncident(deps, kind, {
      reference: `ACME-${2000 + i}-${kind.toUpperCase()}`, beneficiaryId: OFFLINE_BENEFICIARIES[0]!.id, amountMinor: 2_500, currency: "USD", method: "LOCAL",
    });
    ids[kind] = seeded.id;
  }
  const toolbox = createToolbox({
    ledger: runtime.ledger, gateway: runtime.gateway, commander: runtime.commander, closer: runtime.closer, model: runtime.model,
    cards: runtime.cards, actor: "agent:scripted", acceptClientText: false,
  });
  const call = async (tool: string, input: Record<string, unknown>): Promise<ToolOutcome> => toolbox.call(tool, input);
  /** Reads every unread supplier message on the incident, as an agent would, so the evidence is on record. */
  const readMail = async (id: string) => {
    for (const m of runtime.ledger.inboxMessages(id)) expect((await call("read_supplier_message", { incidentId: id, messageId: m.id })).ok).toBe(true);
  };
  return { runtime, ids, call, readMail };
}

const result = <T>(outcome: ToolOutcome): T => {
  if (!outcome.ok) throw new Error(`expected ok, got ${JSON.stringify(outcome)}`);
  return outcome.result as T;
};

describe("paying a supplier invoice by Visa card", () => {
  it("is offered only where a replacement transfer would be, and recommended once the supplier is chasing the money", async () => {
    const { runtime, ids, readMail } = await offline(["transient", "duplicate", "wait", "correction", "card"]);
    const { commander } = runtime;
    const decision = async (kind: string) => (await commander.assess(ids[kind]!)).decision;

    // Returned money and a transient fault: a replacement is allowed, so is a card. Without a chase, the transfer is first.
    expect((await decision("transient")).allowed).toContain("PAY_BY_CARD");
    expect((await decision("transient")).recommended).toBe("REPLACE");
    // A possible duplicate, a transfer still in flight, details that must change first: no replacement, so no card either.
    for (const kind of ["duplicate", "wait", "correction"]) {
      const d = await decision(kind);
      expect(d.allowed).not.toContain("PAY_BY_CARD");
      expect(d.allowed).not.toContain("REPLACE");
    }
    // The supplier says nothing arrived and the deadline passed: the card is the faster rail, and recommended.
    await readMail(ids.card!);
    const recorded = effectiveEvidence(runtime.ledger.events(ids.card!), 2_500)!.evidence;
    expect(recorded.claimsNonReceipt).toBe(true);
    const assessed = await commander.assess(ids.card!, recorded);
    expect(assessed.decision.recommended).toBe("PAY_BY_CARD");
    expect(assessed.decision.reasons.at(-1)).toContain("Trusted Agent Protocol");
  });

  it("is never offered where the agent could not pay a card (no TAP merchant), though transfers still work", () => {
    const facts = {
      obligation: { id: "o", amountMinor: 2_500, currency: "USD", status: "NEEDS_ACTION", escalationReason: null },
      attempts: [{ id: "a", seq: 1, state: "DEAD", failureCode: "91402", amountMinor: 2_500, currency: "USD", feeMinor: 0, method: "LOCAL" } as Attempt],
      paidObservedAt: null, failedObservedAt: null, automaticReplacements: 0, wallets: { USD: 10_000_000 }, fxRates: {}, funding: null,
      evidence: null, now: new Date(),
    } satisfies IncidentFacts;
    expect(decide(facts).allowed).not.toContain("PAY_BY_CARD");
    expect(decide({ ...facts, cardsOffered: true }).allowed).toContain("PAY_BY_CARD");
  });

  it("goes request, signature, TAP checkout, clearing, certificate: one payment, and no transfer while the card holds", async () => {
    const { runtime, ids, call, readMail } = await offline(["card"]);
    const { ledger, cards, commander, gateway } = runtime;
    const id = ids.card!;
    await readMail(id);

    // 1. The agent asks. Every term comes from the invoice; the card waits for a person and takes the invoice's lock.
    const asked = result<{ outcome: string; card: { state: string; cap: string; singleUse: boolean } }>(
      await call("pay_invoice_by_card", { incidentId: id, reason: "The supplier's deadline passed and the transfer was returned." }),
    );
    expect(asked).toMatchObject({ outcome: "REQUESTED", card: { state: "PENDING", cap: "$25.00", singleUse: true } });
    const card = ledger.invoiceCard(id)!;
    expect(card).toMatchObject({ obligationId: id, amountMinor: 2_500, currency: "USD", category: "supplier", merchant: "spike-us-supplier", requestedBy: "agent:scripted" });
    expect(ledger.requireObligation(id).status).toBe("PAYING");

    // While the card holds the invoice, no transfer: not by policy, and not even with a person's signed approval.
    const replace = await call("replace_payment", { incidentId: id });
    expect(replace.ok).toBe(false);
    const previous = ledger.latestAttempt(id)!;
    const approval = issueApproval(
      {
        obligationId: id, amountMinor: 2_500, currency: "USD", beneficiaryId: previous.beneficiaryId, method: "LOCAL", reason: previous.reason,
        replacesAttemptId: previous.id, evidenceHash: "a".repeat(64), mode: "HUMAN", approver: OPERATOR, note: SIGN_NOTE,
        expiresAt: new Date(Date.now() + 60_000).toISOString(), nonce: newNonce(),
      },
      runtime.approvalSecret,
    );
    await expect(gateway.submit(approval)).rejects.toBeInstanceOf(DuplicateLockError);
    expect(ledger.attemptsFor(id)).toHaveLength(1);
    // A second card for the same invoice, and paying before anyone has signed: both refused.
    expect((await call("pay_invoice_by_card", { incidentId: id, reason: "Ask for another card for the same invoice." })).ok).toBe(false);
    expect(ledger.cardsFor(id)).toHaveLength(1);

    // 2. Only a person signs.
    await expect(cards.approve(card.id, "agent:scripted", SIGN_NOTE)).rejects.toThrow(/agent cannot sign/);
    expect((await cards.approve(card.id, OPERATOR, SIGN_NOTE)).state).toBe("ACTIVE");
    expect((await commander.assess(id)).decision.recommended).toBe("PAY_BY_CARD");

    // The generic card tool cannot pay an invoice card around the incident's assessment, nor at another amount.
    const around = await call("pay_with_virtual_card", { cardId: card.id, amount: 25, merchant: card.merchant });
    expect(around.ok).toBe(false);
    await expect(cards.agentCheckout(card.id, { amount: 2_000, merchant: card.merchant }, "agent:scripted")).rejects.toThrow(/exactly \$25\.00/);

    // 3. The agent pays the supplier's checkout through Visa TAP, for exactly the invoice.
    const paid = result<{ outcome: string; checkout: { status: string; tapVerified: boolean; orderId: string } }>(
      await call("pay_invoice_by_card", { incidentId: id, reason: "The card is signed; pay the supplier now." }),
    );
    expect(paid).toMatchObject({ outcome: "PAID", checkout: { status: "APPROVED", tapVerified: true } });
    expect(ledger.requireCard(card.id)).toMatchObject({ state: "SPENT", spentMinor: 2_500 });
    expect(ledger.cardSettlements(card.id)).toHaveLength(1);
    expect(ledger.cardSettlements(card.id)[0]!.matches).toBe(true);
    expect(ledger.requireObligation(id).status).toBe("PAID");
    // The card story is on the invoice's own line of the chain.
    const types = ledger.events(id).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["CARD_REQUESTED", "CARD_DECIDED", "CARD_ISSUED", "CARD_CHECKOUT", "CARD_CHARGE", "CARD_SETTLED", "CARD_STATUS"]));

    // 4. Paid once: neither a second card payment nor a transfer.
    expect((await call("pay_invoice_by_card", { incidentId: id, reason: "Pay the supplier a second time." })).ok).toBe(false);
    await expect(gateway.submit({ ...approval })).rejects.toBeInstanceOf(Error);

    // 5. Certified with the card in the certificate, beside the failed transfer it replaced.
    const assessed = await commander.assess(id);
    expect(assessed.decision.recommended).toBe("CLOSE");
    const closed = result<{ closed: boolean; certificateHash: string; totals: { paidMinor: number } }>(await call("reconcile_and_close", { incidentId: id }));
    expect(closed).toMatchObject({ closed: true, totals: { paidMinor: 2_500 } });
    const certificate = JSON.parse(ledger.getCertificateJson(id)!);
    expect(certificate.body).toMatchObject({
      version: 4, settledTransferId: null, settledAttemptId: null,
      card: { cardId: card.id, amountMinor: 2_500, currency: "USD", merchant: "spike-us-supplier", approvedBy: OPERATOR, tap: { verified: true } },
    });
    expect(certificate.body.attempts).toHaveLength(1);
    expect(certificate.body.attempts[0].state).toBe("DEAD");
    expect(ledger.requireObligation(id).status).toBe("CLOSED");
    expect(ledger.verifyChain().ok).toBe(true);
  });

  it("escalates a card charge that does not match the invoice, and the Closer will not certify it", async () => {
    const { runtime, ids, call, readMail } = await offline(["card"]);
    const { ledger, cards, commander } = runtime;
    const id = ids.card!;
    await readMail(id);
    result(await call("pay_invoice_by_card", { incidentId: id, reason: "The supplier's deadline passed and the transfer was returned." }));
    const card = await cards.approve(ledger.invoiceCard(id)!.id, OPERATOR, SIGN_NOTE);

    // Someone charges the card at another merchant: within its cap and category, so Airwallex lets it through.
    await cards.simulateCharge(card.id, { amount: 25, merchantCategoryCode: "7399", merchant: "Someone Else Ltd" });
    const { decision } = await commander.assess(id);
    expect(decision.recommended).toBe("ESCALATE");
    expect(decision.severity).toBe("CRITICAL");
    expect(decision.allowed).not.toContain("CLOSE");
    expect((await call("reconcile_and_close", { incidentId: id })).ok).toBe(false);
  });

  it("a declined card releases the invoice, so a transfer may replace it after all", async () => {
    const { runtime, ids, call, readMail } = await offline(["card"]);
    const { ledger, cards } = runtime;
    const id = ids.card!;
    await readMail(id);
    result(await call("pay_invoice_by_card", { incidentId: id, reason: "The supplier's deadline passed and the transfer was returned." }));
    cards.decline(ledger.invoiceCard(id)!.id, OPERATOR, "Pay this one by transfer, the supplier prefers it.");

    expect(ledger.invoiceCard(id)).toBeNull();
    expect(ledger.requireObligation(id).status).toBe("NEEDS_ACTION");
    expect((await runtime.commander.assess(id)).decision.allowed).toEqual(expect.arrayContaining(["REPLACE", "PAY_BY_CARD"]));
  });
});

describe("the invoice lock across both rails, in the database itself", () => {
  const terms = {
    purpose: "Invoice INV-1", merchant: "Northwind", category: "supplier", mccs: ["7399"], amountMinor: 2_500, currency: "USD", singleUse: true,
    activeTo: new Date(Date.now() + 86_400_000).toISOString(), requestedBy: "agent:a", reason: "the transfer was returned",
  };
  const setup = () => {
    const ledger = new Ledger(":memory:");
    const o = ledger.createObligation({ reference: "INV-1", beneficiaryId: "ben", amountMinor: 2_500, currency: "USD", method: "LOCAL", reason: "goods" });
    const attempt = (seq: number) =>
      ledger.insertAttempt({ obligationId: o.id, seq, requestId: `req-${seq}`, beneficiaryId: "ben", amountMinor: 2_500, currency: "USD", method: "LOCAL", reason: "goods", approvalNonce: `n-${seq}` });
    return { ledger, o, attempt };
  };

  it("refuses a card while a transfer is open, and a transfer while a card holds the invoice", () => {
    const { ledger, o, attempt } = setup();
    const first = attempt(1);
    expect(() => ledger.requestCard({ ...terms, obligationId: o.id })).toThrow(DuplicateLockError);
    ledger.updateAttempt(first.id, { state: "DEAD" });

    const card = ledger.requestCard({ ...terms, obligationId: o.id });
    expect(() => attempt(2)).toThrow(DuplicateLockError);
    expect(() => ledger.requestCard({ ...terms, obligationId: o.id })).toThrow(DuplicateLockError);

    // Declined: the lock is released, and a transfer may be attempted again.
    ledger.declineCard(card.id, "operator:dana", "pay this one by transfer instead");
    expect(attempt(2).state).toBe("INTENT");
    // And a card that failed to issue cannot be revived on top of that open transfer.
    expect(() => ledger.requestCard({ ...terms, obligationId: o.id })).toThrow(DuplicateLockError);
  });

  it("keeps the lock once a card has spent, whatever its state says", () => {
    const { ledger, o, attempt } = setup();
    ledger.updateAttempt(attempt(1).id, { state: "DEAD" });
    const card = ledger.requestCard({ ...terms, obligationId: o.id });
    ledger.beginCardIssue(card.id, "holder", { by: "operator:dana", note: "approved for the supplier invoice" });
    ledger.cardIssued(card.id, { awxCardId: "awx-1", last4: "4242", brand: "VISA", awxStatus: "ACTIVE" });
    ledger.recordCardCharge({ transactionId: "tx-1", cardId: card.id, type: "CLEARING", status: "PENDING", amountMinor: 2_500, currency: "USD", merchant: "Northwind", mcc: "7399", failureReason: null, at: new Date().toISOString() });
    ledger.setCardState(card.id, "CLOSED", "operator:dana", "closed by hand", "CLOSED");

    expect(ledger.invoiceCard(o.id)?.id).toBe(card.id);
    expect(ledger.requireObligation(o.id).status).toBe("PAID");
    expect(() => attempt(2)).toThrow(DuplicateLockError);
  });

  it("brings a ledger file from before invoice cards up to date, lock and all", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tessera-")), "old.db");
    const old = new Ledger(path);
    old.db.exec(
      "DROP INDEX one_card_per_invoice; DROP TRIGGER card_holds_invoice_lock; DROP TRIGGER transfer_holds_invoice_lock; DROP TRIGGER invoice_card_revived; ALTER TABLE cards DROP COLUMN obligationId;",
    );
    old.close();

    const { ledger, o, attempt } = (() => {
      const ledger = new Ledger(path);
      const o = ledger.createObligation({ reference: "INV-2", beneficiaryId: "ben", amountMinor: 2_500, currency: "USD", method: "LOCAL", reason: "goods" });
      const attempt = (seq: number) =>
        ledger.insertAttempt({ obligationId: o.id, seq, requestId: `r-${seq}`, beneficiaryId: "ben", amountMinor: 2_500, currency: "USD", method: "LOCAL", reason: "goods", approvalNonce: `m-${seq}` });
      return { ledger, o, attempt };
    })();
    ledger.updateAttempt(attempt(1).id, { state: "DEAD" });
    ledger.requestCard({ ...terms, obligationId: o.id });
    expect(() => attempt(2)).toThrow(DuplicateLockError);
  });
});

describe("the supplier's checkout binds a TAP payment to one invoice", () => {
  const key = agentKeyFrom("a workspace secret");
  const charged: string[] = [];
  const merchant = new SandboxMerchant({
    keys: (kid) => (kid === key.kid ? key.publicKey : null),
    charger: { charge: async (input) => (charged.push(input.cardId), { process_result: "APPROVED", failure_reason: null }) },
  });
  const checkout = (signedFor: string, postedTo: string, containerFor: string, orderFor: string) => {
    const nonce = tapNonce();
    const path = `/invoices/${signedFor}/pay`;
    const headers = signRequest({ key, authority: new URL(SANDBOX_MERCHANT_ORIGIN).host, path, tag: "agent-payer-auth", nonce });
    const container = signObject(key, { nonce, paymentToken: "card-1", lastFour: "4242", invoice: containerFor });
    return merchant.checkout(
      new Request(`${SANDBOX_MERCHANT_ORIGIN}/invoices/${postedTo}/pay`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ order: { merchant: "Northwind", description: "x", amount: 25, currency: "USD", merchantCategoryCode: "7399", invoice: orderFor }, agenticPaymentContainer: container }),
      }),
    );
  };

  it("pays the invoice the agent signed for, and refuses the same signature or container aimed at another invoice", async () => {
    expect(await checkout("INV-1", "INV-1", "INV-1", "INV-1")).toMatchObject({ status: "APPROVED" });
    expect(await checkout("INV-1", "INV-2", "INV-1", "INV-2")).toMatchObject({ status: "REJECTED", reason: "the signature does not match the request" });
    expect(await checkout("INV-2", "INV-2", "INV-1", "INV-2")).toMatchObject({ status: "REJECTED", reason: expect.stringContaining("not bound to this invoice") });
    expect(await checkout("INV-2", "INV-2", "INV-2", "INV-1")).toMatchObject({ status: "REJECTED", reason: expect.stringContaining("not bound to this invoice") });
    expect(charged).toHaveLength(1);
  });
});
