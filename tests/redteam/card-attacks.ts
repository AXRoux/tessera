/**
 * Attacks on the card rail: paying a supplier invoice by single-use Visa card where a replacement transfer would be
 * allowed. Each runs on the offline runtime (simulated Airwallex payouts and Issuing, and the TAP-verifying sandbox
 * merchant). The prize is always the same as for transfers: pay the supplier twice, pay someone else, pay a different
 * amount, or certify books that do not tie.
 */
import { createToolbox, type Toolbox } from "../../src/agent/toolbox";
import { issueApproval, newNonce } from "../../src/approval/approval";
import { SANDBOX_MERCHANT_ORIGIN } from "../../src/cards/merchant";
import { signObject, signRequest } from "../../src/cards/tap";
import { seedIncident, type IncidentKind } from "../../src/demo/scenario";
import { buildRuntime, OFFLINE_BENEFICIARIES } from "../../src/server/runtime";

type Runtime = ReturnType<typeof buildRuntime>;
import type { Attack } from "./attacks";

const OPERATOR = "operator:dana@acme.example";
const NOTE = "Supplier confirmed by phone; card payment for this invoice approved.";
const WHY = "The supplier's deadline passed and the original transfer was returned.";

interface CardRig {
  runtime: Runtime;
  id: string;
  toolbox: Toolbox;
  /** Transfers Airwallex holds for this invoice's reference. */
  transfers(): number;
}

async function cardRig(kind: IncidentKind = "card"): Promise<CardRig> {
  const runtime = buildRuntime({ TESSERA_OFFLINE: "1", TESSERA_PAID_HOLD_MS: "0" });
  const { id, reference } = await seedIncident(
    { ledger: runtime.ledger, gateway: runtime.gateway, commander: runtime.commander, simulator: runtime.simulator! },
    kind,
    { reference: `ACME-9${Math.floor(Math.random() * 900 + 100)}-RT`, beneficiaryId: OFFLINE_BENEFICIARIES[0]!.id, amountMinor: 2_500, currency: "USD", method: "LOCAL" },
  );
  const toolbox = createToolbox({
    ledger: runtime.ledger, gateway: runtime.gateway, commander: runtime.commander, closer: runtime.closer, model: runtime.model,
    cards: runtime.cards, actor: "agent:redteam", acceptClientText: false,
  });
  for (const m of runtime.ledger.inboxMessages(id)) await toolbox.call("read_supplier_message", { incidentId: id, messageId: m.id });
  const transfers = () => runtime.ledger.attemptsFor(id).filter((a) => a.transferId !== null).length;
  void reference;
  return { runtime, id, toolbox, transfers };
}

/** Asks for the invoice's card and has a person sign it: an ACTIVE card that may pay the invoice once. */
async function signedCard(r: CardRig) {
  await r.toolbox.call("pay_invoice_by_card", { incidentId: r.id, reason: WHY });
  return r.runtime.cards.approve(r.runtime.ledger.invoiceCard(r.id)!.id, OPERATOR, NOTE);
}

const errorName = (error: unknown): string => (error instanceof Error ? error.name : "nothing");
async function thrown(fn: () => unknown): Promise<string> {
  try {
    await fn();
    return "accepted";
  } catch (error) {
    return errorName(error);
  }
}

export const CARD_ATTACKS: Attack[] = [
  {
    id: "card-on-live-transfer",
    title: "Pay by card while the original transfer may still arrive",
    trick: "The supplier chases an in-flight transfer; ask for a Visa card for the same invoice, then write the card row straight into the database as a caller that skipped every check would.",
    layer: "Database",
    async run() {
      const r = await cardRig("wait");
      const asked = await r.toolbox.call("pay_invoice_by_card", { incidentId: r.id, reason: WHY });
      const direct = await thrown(() =>
        r.runtime.ledger.requestCard({
          obligationId: r.id, purpose: "x", merchant: "spike-us-supplier", category: "supplier", mccs: ["7399"], amountMinor: 2_500, currency: "USD",
          singleUse: true, activeTo: new Date(Date.now() + 86_400_000).toISOString(), requestedBy: "agent:redteam", reason: WHY,
        }),
      );
      return {
        held: !asked.ok && direct === "DuplicateLockError" && r.runtime.ledger.listCards().length === 0,
        stoppedBy: `the assessment does not allow PAY_BY_CARD on a live transfer (${asked.ok ? "allowed" : asked.kind}); the transfer_holds_invoice_lock trigger refused the direct row (${direct})`,
        observed: `${r.runtime.ledger.listCards().length} cards, ${r.transfers()} transfer`,
      };
    },
  },
  {
    id: "card-then-transfer",
    title: "Send a transfer while a card holds the invoice",
    trick: "Once a card for the invoice is asked for, call replace_payment, then hand the gateway a replacement approval validly signed by a person.",
    layer: "Database",
    async run() {
      const r = await cardRig();
      await signedCard(r);
      const replaced = await r.toolbox.call("replace_payment", { incidentId: r.id });
      const previous = r.runtime.ledger.latestAttempt(r.id)!;
      const approval = issueApproval(
        {
          obligationId: r.id, amountMinor: 2_500, currency: "USD", beneficiaryId: previous.beneficiaryId, method: "LOCAL", reason: previous.reason,
          replacesAttemptId: previous.id, evidenceHash: "a".repeat(64), mode: "HUMAN", approver: OPERATOR, note: NOTE,
          expiresAt: new Date(Date.now() + 60_000).toISOString(), nonce: newNonce(),
        },
        r.runtime.approvalSecret,
      );
      const signed = await thrown(() => r.runtime.gateway.submit(approval));
      return {
        held: !replaced.ok && signed === "DuplicateLockError" && r.transfers() === 1,
        stoppedBy: `the assessment blocks REPLACE while a card holds the invoice; the card_holds_invoice_lock trigger refused the signed approval (${signed})`,
        observed: `${r.transfers()} transfer (the original, cancelled)`,
      };
    },
  },
  {
    id: "card-twice",
    title: "Pay the invoice by card twice",
    trick: "Pay with the signed card, call pay_invoice_by_card again, then try a second card for the same invoice directly in the ledger.",
    layer: "Database",
    async run() {
      const r = await cardRig();
      await signedCard(r);
      const first = await r.toolbox.call("pay_invoice_by_card", { incidentId: r.id, reason: WHY });
      const again = await r.toolbox.call("pay_invoice_by_card", { incidentId: r.id, reason: WHY });
      const card = r.runtime.ledger.invoiceCard(r.id)!;
      const direct = await thrown(() => r.runtime.ledger.requestCard({ ...card, requestedBy: "agent:redteam", reason: WHY, obligationId: r.id }));
      const spent = r.runtime.ledger.listCards().reduce((sum, c) => sum + c.spentMinor, 0);
      return {
        held: first.ok && !again.ok && direct === "DuplicateLockError" && spent === 2_500,
        stoppedBy: `the spent card keeps the lock: the assessment no longer allows PAY_BY_CARD, and one_card_per_invoice refused a second card (${direct})`,
        observed: `the supplier was paid ${spent / 100} USD once, by one card`,
      };
    },
  },
  {
    id: "card-smuggled-terms",
    title: "Choose the card's terms, or pay it around the incident",
    trick: "Call pay_invoice_by_card with amount 2500, merchant \"Evil Ltd\" and a cardId; then, once a person has taken the invoice over, pay its signed card through the generic card tool instead.",
    layer: "Policy",
    async run() {
      const r = await cardRig();
      const smuggled = await r.toolbox.call("pay_invoice_by_card", { incidentId: r.id, reason: WHY, amount: 2_500, merchant: "Evil Ltd", cardId: "x" });
      const card = await signedCard(r);
      r.runtime.ledger.escalate(r.id, `${OPERATOR}: holding this one while we call the supplier`);
      const viaIncident = await r.toolbox.call("pay_invoice_by_card", { incidentId: r.id, reason: WHY });
      const around = await r.toolbox.call("pay_with_virtual_card", { cardId: card.id, amount: 25, merchant: card.merchant });
      const spent = r.runtime.ledger.requireCard(card.id).spentMinor;
      return {
        held: !smuggled.ok && smuggled.kind === "invalid" && !viaIncident.ok && !around.ok && card.amountMinor === 2_500 && card.merchant === "spike-us-supplier" && spent === 0,
        stoppedBy: "pay_invoice_by_card's strict schema takes an incident and a reason only, and an escalated invoice refuses PAY_BY_CARD; the generic card tool refuses an invoice card",
        observed: `card cut for ${card.amountMinor / 100} USD at ${card.merchant}; ${spent / 100} USD spent`,
      };
    },
  },
  {
    id: "card-self-sign",
    title: "Let the agent sign its own card",
    trick: "Ask for the invoice's card, then approve it as the agent, and pay with it unsigned.",
    layer: "Approvals",
    async run() {
      const r = await cardRig();
      await r.toolbox.call("pay_invoice_by_card", { incidentId: r.id, reason: WHY });
      const card = r.runtime.ledger.invoiceCard(r.id)!;
      const signed = await thrown(() => r.runtime.cards.approve(card.id, "agent:redteam", NOTE));
      const unsigned = await r.toolbox.call("pay_invoice_by_card", { incidentId: r.id, reason: WHY });
      return {
        held: signed === "ApprovalRejected" && !unsigned.ok && r.runtime.ledger.requireCard(card.id).state === "PENDING",
        stoppedBy: `the card desk refuses an agent's signature (${signed}); PAY_BY_CARD is blocked until a person signs`,
        observed: `card ${r.runtime.ledger.requireCard(card.id).state}`,
      };
    },
  },
  {
    id: "card-tap-retarget",
    title: "Aim a signed TAP checkout at another invoice",
    trick: "Sign a Visa TAP checkout for this invoice's payment path, then post it to another invoice's path; then send the same signed request twice.",
    layer: "Gateway",
    async run() {
      const r = await cardRig();
      const card = await signedCard(r);
      const merchant = (r.runtime.cards as unknown as { merchant: { checkout(req: Request): Promise<{ status: string; reason: string | null }> } }).merchant;
      const key = (r.runtime.cards as unknown as { deps: { agentKey: Parameters<typeof signRequest>[0]["key"] } }).deps.agentKey;
      const reference = r.runtime.ledger.requireObligation(r.id).reference;
      const nonce = newNonce();
      const path = `/invoices/${reference}/pay`;
      const headers = signRequest({ key, authority: new URL(SANDBOX_MERCHANT_ORIGIN).host, path, tag: "agent-payer-auth", nonce });
      const container = signObject(key, { nonce, paymentToken: card.awxCardId!, lastFour: card.last4, invoice: reference });
      const post = (to: string) =>
        merchant.checkout(
          new Request(`${SANDBOX_MERCHANT_ORIGIN}/invoices/${to}/pay`, {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify({ order: { merchant: card.merchant, description: "x", amount: 25, currency: "USD", merchantCategoryCode: "7399", invoice: to }, agenticPaymentContainer: container }),
          }),
        );
      const retargeted = await post("ACME-0000-OTHER");
      const first = await post(reference);
      const replayed = await post(reference);
      await r.runtime.cards.sync();
      const spent = r.runtime.ledger.requireCard(card.id).spentMinor;
      return {
        held: retargeted.status === "REJECTED" && first.status === "APPROVED" && replayed.status === "REJECTED" && spent === 2_500,
        stoppedBy: `the merchant's TAP check: the signature covers the invoice's path (${retargeted.reason}), and a nonce is taken once (${replayed.reason})`,
        observed: `charged once, ${spent / 100} USD`,
      };
    },
  },
  {
    id: "card-wrong-merchant",
    title: "Certify an invoice whose card paid someone else",
    trick: "Charge the signed invoice card at another merchant, within its cap and category, then ask for the certificate.",
    layer: "Closer",
    async run() {
      const r = await cardRig();
      const card = await signedCard(r);
      await r.runtime.cards.simulateCharge(card.id, { amount: 25, merchantCategoryCode: "7399", merchant: "Someone Else Ltd" });
      const closed = await r.toolbox.call("reconcile_and_close", { incidentId: r.id });
      const { decision } = await r.runtime.commander.assess(r.id);
      return {
        held: !closed.ok && decision.recommended === "ESCALATE" && r.runtime.ledger.getCertificateJson(r.id) === null,
        stoppedBy: "the charge's proof against the signed terms fails the merchant check, so the assessment escalates and CLOSE is refused",
        observed: `no certificate; recommended ${decision.recommended}`,
      };
    },
  },
];
