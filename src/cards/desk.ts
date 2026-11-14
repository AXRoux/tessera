/**
 * The card desk: Visa virtual cards issued by Airwallex, one per approved purchase.
 *
 * Asking is open to people and to agents. Code checks every request (src/cards/policy.ts) before a person sees it; a
 * named person signs it with a written note; only then is the card cut at Airwallex, with the signed terms as the card's
 * own controls (a cap per charge and for life, one currency, merchant categories, single use, an end date), so the Visa
 * network refuses what the policy refused. An agent can then pay with the card, but only at the merchant the person
 * named, and only through Visa's Trusted Agent Protocol: every checkout is signed with the agent's key and verified by
 * the merchant before anything is charged. Every step is a hash-chained ledger event.
 */
import { WRITTEN_NOTE_MIN_CHARS } from "../approval/approval";
import type { CardChargeSimulator, IssuingApi } from "../airwallex/issuing";
import { lastFour } from "../airwallex/issuing";
import { AwxHttpError, type BalanceApi } from "../airwallex/types";
import { ApprovalRejected, StateConflict } from "../errors";
import { chargeHoldsMinor, chargeTakesMinor, type CardCharge, type CardRow, type CardSettlement, type CardState, type SettlementCheck } from "../ledger/cards";
import type { Ledger } from "../ledger/ledger";
import { formatMinor, fromMinor, toMinor } from "../money";
import { SANDBOX_MERCHANT_ORIGIN, SandboxMerchant, type CheckoutResult } from "./merchant";
import { CARD_CATEGORIES, checkCardRequest, DEFAULT_CARD_POLICY, type CardPolicy } from "./policy";
import { newNonce, publicJwk, signObject, signRequest, type TapJwk, type TapKey } from "./tap";

/** The delegate cardholder Tessera issues to: an email for "the agents of this business", no person behind it. */
export const AGENT_CARDHOLDER_EMAIL = "agent@tessera.dev";
const LIVE_STATES: readonly CardState[] = ["PENDING", "ISSUING", "ACTIVE", "FROZEN"];
/** How long an ISSUING card may go unmatched at Airwallex before the sweep calls the create lost. */
const LOST_ISSUE_MS = 2 * 60_000;

export interface CardRequestInput {
  purpose: string;
  merchant: string;
  category: string;
  /** Major units. */
  amount: number;
  currency: string;
  singleUse?: boolean;
  reason: string;
  /** `operator:<name>` or `agent:<name>`. */
  requestedBy: string;
}

export interface CardDeskDeps {
  ledger: Ledger;
  /** Airwallex Issuing, real or simulated. Null: requests are recorded and refused ("issuing is not connected"). */
  issuing: IssuingApi | null;
  /** Sandbox or offline only: a merchant charging a card. Null against production. */
  charger: CardChargeSimulator | null;
  balances: BalanceApi;
  reserveFloorMinor: Readonly<Record<string, number>>;
  /** The agent's TAP signing key (src/cards/tap.ts). */
  agentKey: TapKey;
  policy?: CardPolicy;
  now?: () => Date;
}

export interface AgentCheckout {
  card: CardRow;
  result: CheckoutResult;
}

const isAgent = (actor: string): boolean => actor.startsWith("agent:");

/** "Framer, Inc." and "FRAMER" are the same merchant; Airwallex pads and shouts merchant names. */
const merchantKey = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Proves one cleared charge against what a person signed: the merchant they named, the cap, the card's merchant
 * categories, its currency, its single use, and that a person (not an agent) signed it. Airwallex enforces the cap,
 * categories, currency and single use at authorisation; the merchant name only Tessera can check.
 */
export function settle(card: CardRow, charge: CardCharge, charges: readonly CardCharge[]): CardSettlement {
  const amount = Math.abs(charge.amountMinor);
  const spending = charges.filter((c) => chargeTakesMinor(c) > 0 || chargeHoldsMinor(c) > 0);
  const signed = card.merchant.trim();
  const named = charge.merchant ? merchantKey(charge.merchant) : "";
  const merchantOk = named.length > 0 && (named.includes(merchantKey(signed)) || merchantKey(signed).includes(named));
  const fmt = (minor: number) => formatMinor(minor, card.currency);
  const checks: SettlementCheck[] = [
    {
      check: "merchant",
      ok: merchantOk,
      detail: charge.merchant ? (merchantOk ? `charged by ${charge.merchant}, the merchant signed for` : `charged by ${charge.merchant}, but signed for ${signed}`) : `Airwallex did not name the merchant; signed for ${signed}`,
    },
    {
      check: "cap",
      ok: amount <= card.amountMinor && card.spentMinor <= card.amountMinor,
      detail: `${fmt(amount)} against a cap of ${fmt(card.amountMinor)}`,
    },
    {
      check: "category",
      ok: charge.mcc !== null && card.mccs.includes(charge.mcc),
      detail: charge.mcc ? `${charge.mcc}${card.mccs.includes(charge.mcc) ? ", one the card allows" : `, not one of ${card.mccs.join(", ")}`}` : "none reported",
    },
    { check: "currency", ok: charge.currency === card.currency, detail: `charged in ${charge.currency}, signed in ${card.currency}` },
    {
      check: "single_use",
      ok: !card.singleUse || spending.length <= 1,
      detail: card.singleUse ? (spending.length <= 1 ? "the card's one charge" : `${spending.length} charges on a single-use card`) : "a card for more than one charge",
    },
    {
      check: "signed",
      ok: card.approvedBy !== null && !isAgent(card.approvedBy),
      detail: card.approvedBy ? `signed by ${card.approvedBy.replace(/^\w+:/, "")}` : "no signature on record",
    },
  ];
  return {
    cardId: card.id,
    transactionId: charge.transactionId,
    amountMinor: amount,
    currency: charge.currency,
    merchant: charge.merchant,
    mcc: charge.mcc,
    checks,
    matches: checks.every((c) => c.ok),
  };
}
const nickFor = (card: Pick<CardRow, "id" | "merchant">): string => `tessera:${card.id.slice(0, 8)} ${card.merchant}`.slice(0, 40);

export class CardDesk {
  readonly policy: CardPolicy;
  private readonly merchant: SandboxMerchant | null;
  private cardholderId: string | null = null;

  constructor(private readonly deps: CardDeskDeps) {
    this.policy = deps.policy ?? DEFAULT_CARD_POLICY;
    const key = deps.agentKey;
    this.merchant = deps.charger
      ? new SandboxMerchant({ keys: (kid) => (kid === key.kid ? key.publicKey : null), charger: deps.charger, now: () => Math.floor(this.now().getTime() / 1000) })
      : null;
  }

  /** The agent's public key, as Visa TAP's key retrieval publishes it. */
  get agentJwk(): TapJwk {
    return publicJwk(this.deps.agentKey);
  }

  get issuingConnected(): boolean {
    return this.deps.issuing !== null;
  }

  get canCharge(): boolean {
    return this.merchant !== null;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  list(): CardRow[] {
    return this.deps.ledger.listCards();
  }

  charges(cardId: string): CardCharge[] {
    return this.deps.ledger.cardCharges(cardId);
  }

  /** Each cleared charge on the card, proved against the signed terms. */
  settlements(cardId: string) {
    return this.deps.ledger.cardSettlements(cardId);
  }

  /** Records a request, then lets code decide: PENDING (a person signs next) or REFUSED, with the reasons. */
  async request(input: CardRequestInput): Promise<CardRow> {
    const { ledger } = this.deps;
    const currency = input.currency.toUpperCase();
    const category = CARD_CATEGORIES[input.category];
    const amountMinor = toMinor(input.amount, currency);
    const activeTo = new Date(this.now().getTime() + this.policy.lifetimeDays * 86_400_000).toISOString();
    const card = ledger.requestCard({
      purpose: input.purpose.trim().slice(0, 120),
      merchant: input.merchant.trim().slice(0, 60),
      category: input.category,
      mccs: category ? [...category.mccs] : [],
      amountMinor,
      currency,
      singleUse: input.singleUse ?? true,
      activeTo,
      requestedBy: input.requestedBy,
      reason: input.reason.trim().slice(0, 500),
    });
    const reasons = checkCardRequest(card, card.reason, await this.context(card), this.policy);
    if (!this.deps.issuing) reasons.push("Airwallex Issuing is not connected to this workspace");
    return reasons.length > 0 ? ledger.refuseCard(card.id, reasons) : card;
  }

  /** What the policy needs to know besides the request: today's total, live cards, and the wallet above its floor. */
  private async context(card: CardRow) {
    const today = this.now().toISOString().slice(0, 10);
    const others = this.deps.ledger.listCards().filter((c) => c.id !== card.id);
    const requestedTodayMinor = others
      .filter((c) => c.currency === card.currency && c.createdAt.startsWith(today) && c.state !== "REFUSED" && c.state !== "DECLINED")
      .reduce((sum, c) => sum + c.amountMinor, 0);
    const liveCards = others.filter((c) => LIVE_STATES.includes(c.state)).length;
    let spendableMinor: number | null = null;
    try {
      const wallet = (await this.deps.balances.getBalances()).find((b) => b.currency === card.currency);
      spendableMinor = wallet ? toMinor(wallet.available_amount, card.currency) - (this.deps.reserveFloorMinor[card.currency] ?? 0) : 0;
    } catch {
      spendableMinor = null;
    }
    return { byAgent: isAgent(card.requestedBy), requestedTodayMinor, liveCards, spendableMinor };
  }

  private async ensureCardholder(): Promise<string> {
    if (this.cardholderId) return this.cardholderId;
    const issuing = this.requireIssuing();
    const existing = (await issuing.listCardholders()).find((c) => c.email === AGENT_CARDHOLDER_EMAIL && c.status === "READY");
    this.cardholderId = existing?.cardholder_id ?? (await issuing.createDelegateCardholder(AGENT_CARDHOLDER_EMAIL)).cardholder_id;
    return this.cardholderId;
  }

  private requireIssuing(): IssuingApi {
    if (!this.deps.issuing) throw new StateConflict("Airwallex Issuing is not connected to this workspace");
    return this.deps.issuing;
  }

  /**
   * A person signs a PENDING card and it is cut at Airwallex. The policy is checked again first (balances move). A
   * definitive refusal from Airwallex leaves it FAILED, with Airwallex's words; an ambiguous one leaves it ISSUING for
   * the sweep to match by nickname.
   */
  async approve(id: string, by: string, note: string): Promise<CardRow> {
    if (isAgent(by)) throw new ApprovalRejected("malformed", "an agent cannot sign a card; a person must");
    if (note.trim().length < WRITTEN_NOTE_MIN_CHARS) throw new ApprovalRejected("malformed", `write a note of at least ${WRITTEN_NOTE_MIN_CHARS} characters to sign a card`);
    const card = this.deps.ledger.requireCard(id);
    if (card.state !== "PENDING") throw new StateConflict(`card ${id} is ${card.state}, not waiting for a signature`);
    const reasons = checkCardRequest(card, card.reason, { ...(await this.context(card)), byAgent: false }, this.policy);
    if (reasons.length > 0) {
      this.deps.ledger.refuseCard(id, reasons);
      throw new StateConflict(`code refused the card on a second look: ${reasons.join("; ")}`);
    }
    const cardholderId = await this.ensureCardholder();
    return this.issue(this.deps.ledger.beginCardIssue(id, cardholderId, { by, note: note.trim() }), cardholderId, by);
  }

  /** Tries a FAILED card again (Airwallex said no; perhaps issuing has since been enabled), with a new request id. */
  async retry(id: string, by: string): Promise<CardRow> {
    if (isAgent(by)) throw new ApprovalRejected("malformed", "an agent cannot retry a card; a person must");
    const cardholderId = await this.ensureCardholder();
    return this.issue(this.deps.ledger.beginCardIssue(id, cardholderId, null), cardholderId, by);
  }

  private async issue(card: CardRow, cardholderId: string, by: string): Promise<CardRow> {
    const issuing = this.requireIssuing();
    try {
      const issued = await issuing.createCard({
        requestId: card.requestId,
        cardholderId,
        createdBy: by.replace(/^\w+:/, "").slice(0, 80) || "Tessera",
        nickName: nickFor(card),
        controls: { currency: card.currency, limit: fromMinor(card.amountMinor, card.currency), merchantCategories: card.mccs, singleUse: card.singleUse, activeTo: card.activeTo },
      });
      return this.deps.ledger.cardIssued(card.id, { awxCardId: issued.card_id, last4: lastFour(issued.card_number), brand: issued.brand ?? "VISA", awxStatus: issued.card_status });
    } catch (error) {
      if (error instanceof AwxHttpError && error.status >= 400 && error.status < 500) {
        return this.deps.ledger.cardIssueFailed(card.id, error.code, error.message.replace(/^\d+ [\w.]+: /, ""));
      }
      // A timeout or a 5xx: the card may exist. The sweep looks for it by nickname.
      return this.deps.ledger.requireCard(card.id);
    }
  }

  decline(id: string, by: string, note: string): CardRow {
    if (note.trim().length < WRITTEN_NOTE_MIN_CHARS) throw new ApprovalRejected("malformed", `write a note of at least ${WRITTEN_NOTE_MIN_CHARS} characters to decline a card`);
    return this.deps.ledger.declineCard(id, by, note.trim());
  }

  /** Freeze, unfreeze or close a card, at Airwallex first and then in the ledger. A frozen card declines every charge. */
  async setStatus(id: string, to: "FROZEN" | "ACTIVE" | "CLOSED", by: string, why: string): Promise<CardRow> {
    const card = this.deps.ledger.requireCard(id);
    if (!card.awxCardId) throw new StateConflict(`card ${id} was never issued`);
    const updated = await this.requireIssuing().updateCardStatus(card.awxCardId, to === "FROZEN" ? "INACTIVE" : to);
    return this.deps.ledger.setCardState(id, to, by, why.trim() || (to === "CLOSED" ? "closed" : to === "FROZEN" ? "frozen" : "unfrozen"), updated.card_status);
  }

  /**
   * Brings every card up to date with Airwallex: an ISSUING card is matched by nickname (or called lost after two
   * minutes); each issued card's charges and declines are recorded, and followed until they clear (Airwallex reports a
   * purchase PENDING when it is authorised and APPROVED once it clears, under the same id, about half an hour later on
   * the sandbox); a single-use card that has used its one charge is closed at Airwallex and marked SPENT; and each
   * cleared charge is proved against the terms a person signed (CARD_SETTLED).
   */
  async sync(): Promise<void> {
    const { ledger } = this.deps;
    const issuing = this.deps.issuing;
    if (!issuing) return;
    for (const card of ledger.cardsIn(["ISSUING"])) {
      const cardholderId = await this.ensureCardholder();
      const found = await issuing.findCardByNickName(cardholderId, nickFor(card));
      if (found) ledger.cardIssued(card.id, { awxCardId: found.card_id, last4: lastFour(found.card_number), brand: found.brand ?? "VISA", awxStatus: found.card_status });
      else if (this.now().getTime() - Date.parse(card.updatedAt) > LOST_ISSUE_MS) ledger.cardIssueFailed(card.id, "not_found", "Airwallex has no card for this request");
    }
    // Live cards, and spent or closed ones whose charges have not all cleared yet.
    const clearing = (id: string) => ledger.cardCharges(id).some((c) => c.status === "PENDING");
    const watched = [...ledger.cardsIn(["ACTIVE", "FROZEN"]), ...ledger.cardsIn(["SPENT", "CLOSED"]).filter((c) => clearing(c.id))];
    for (const card of watched) {
      if (!card.awxCardId) continue;
      for (const tx of await issuing.listCardTransactions(card.awxCardId)) {
        const currency = tx.transaction_currency ?? card.currency;
        ledger.recordCardCharge({
          transactionId: tx.transaction_id,
          cardId: card.id,
          type: tx.transaction_type ?? "UNKNOWN",
          status: tx.status ?? "UNKNOWN",
          // Airwallex reports a purchase as a negative amount; the ledger keeps the size, and the type says which way.
          amountMinor: Math.abs(toMinor(tx.transaction_amount ?? 0, currency)),
          currency,
          merchant: tx.merchant?.name?.trim() || null,
          mcc: tx.merchant?.category_code ?? null,
          failureReason: tx.failure_reason ?? null,
          at: tx.transaction_date ?? this.now().toISOString(),
        });
      }
      const fresh = ledger.requireCard(card.id);
      const charges = ledger.cardCharges(card.id);
      // A single-use card is used once a charge is through, cleared or still clearing; a decline does not use it.
      const used = charges.some((c) => chargeTakesMinor(c) > 0 || chargeHoldsMinor(c) > 0);
      if (fresh.singleUse && used && fresh.state === "ACTIVE") {
        const remote = await issuing.getCard(card.awxCardId);
        // Airwallex closes a single-use card itself at authorisation. Tessera closes it only once the charge has cleared,
        // so a close can never race the clearing.
        const closed = remote.card_status === "CLOSED" ? remote : fresh.spentMinor > 0 ? await issuing.updateCardStatus(card.awxCardId, "CLOSED") : null;
        if (closed) {
          const why = fresh.spentMinor > 0 ? "single use: its one charge has cleared" : "single use: Airwallex closed it after its one charge, which is clearing";
          ledger.setCardState(card.id, "SPENT", "tessera", why, closed.card_status);
        }
      }
      for (const charge of charges) {
        if (chargeTakesMinor(charge) > 0) ledger.settleCardCharge(settle(ledger.requireCard(card.id), charge, charges));
      }
    }
  }

  /** Sandbox only: a merchant charges the card directly (a person testing the card's controls). Airwallex decides. */
  async simulateCharge(id: string, input: { amount: number; merchantCategoryCode: string; merchant?: string }): Promise<CardRow> {
    if (!this.deps.charger) throw new StateConflict("merchant charges can be simulated only offline or on the Airwallex sandbox");
    const card = this.deps.ledger.requireCard(id);
    if (!card.awxCardId) throw new StateConflict(`card ${id} was never issued`);
    await this.deps.charger.charge({ cardId: card.awxCardId, amount: input.amount, currency: card.currency, merchantCategoryCode: input.merchantCategoryCode, merchantName: input.merchant ?? card.merchant });
    await this.sync();
    return this.deps.ledger.requireCard(id);
  }

  /**
   * An agent pays with a card, the agentic-commerce way: Tessera refuses unless the card is ACTIVE and the merchant is
   * the one a person named; then the checkout is signed with the agent's TAP key (`agent-payer-auth`) and its payment
   * container is signed and linked by nonce, and the merchant verifies both before it charges. The card number never
   * leaves Tessera, and Airwallex still applies the card's controls to the charge.
   */
  async agentCheckout(id: string, input: { amount: number; merchant: string; description?: string; merchantCategoryCode?: string }, actor: string): Promise<AgentCheckout> {
    const { ledger } = this.deps;
    if (!this.merchant) throw new StateConflict("agent checkout runs only offline or on the Airwallex sandbox");
    const card = ledger.requireCard(id);
    if (card.state !== "ACTIVE" || !card.awxCardId) throw new StateConflict(`card ${id} is ${card.state}; only an active card can pay`);
    if (card.merchant.trim().toLowerCase() !== input.merchant.trim().toLowerCase()) {
      throw new StateConflict(`this card was signed for ${card.merchant}, not ${input.merchant}`);
    }
    const nonce = newNonce();
    const url = new URL("/checkout", SANDBOX_MERCHANT_ORIGIN);
    const key = this.deps.agentKey;
    const headers = signRequest({ key, authority: url.host, path: url.pathname, tag: "agent-payer-auth", nonce, now: Math.floor(this.now().getTime() / 1000) });
    const container = signObject(key, { nonce, paymentToken: card.awxCardId, lastFour: card.last4 });
    const request = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        order: {
          merchant: card.merchant,
          description: (input.description ?? card.purpose).slice(0, 200),
          amount: input.amount,
          currency: card.currency,
          merchantCategoryCode: input.merchantCategoryCode ?? card.mccs[0] ?? "5734",
        },
        agenticPaymentContainer: container,
      }),
    });
    const result = await this.merchant.checkout(request);
    ledger.append(null, "CARD_CHECKOUT", {
      cardId: id,
      actor,
      merchant: card.merchant,
      amountMinor: toMinor(input.amount, card.currency),
      currency: card.currency,
      tap: result.tap.ok ? { verified: true, kid: result.tap.kid, tag: result.tap.tag, nonce: result.tap.nonce } : { verified: false, reason: result.tap.reason },
      status: result.status,
      orderId: result.orderId,
      reason: result.reason,
    });
    await this.sync();
    return { card: ledger.requireCard(id), result };
  }
}
