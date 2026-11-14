import { AwxHttpError } from "./types";
import type {
  Cardholder,
  CardChargeSimulator,
  CardStatus,
  CardTransaction,
  CreateCardRequest,
  IssuedCard,
  IssuingApi,
  SimulatedCharge,
} from "./issuing";

interface FakeCard {
  card: IssuedCard;
  requestId: string;
  spent: number;
}

/**
 * In-memory Airwallex Issuing for the offline demo and tests, playing the controls the way the sandbox documents them:
 * a charge is declined for a closed or frozen card (`CARD_CLOSED`, `CARD_INACTIVE`), after its end date
 * (`OUT_OF_ALLOWED_TIME_RANGE`), in another currency (`CURRENCY_NOT_ALLOWED`), at a merchant category it does not allow
 * (`MERCHANT_CATEGORY_NOT_ALLOWED`), above its per-charge or lifetime limit (`LIMIT_EXCEEDED`, inclusive), or beyond the
 * wallet (`INSUFFICIENT_FUNDS`). A single-use card closes after its one approved charge. An approved charge debits the
 * wallet it was charged in, which is the same balance map as the payout fake when one is passed.
 *
 * Reported the way the sandbox reports them (seen on 2026-11-14): a purchase is a CLEARING transaction with a negative
 * amount, PENDING when authorised and APPROVED under the same id once it clears. The sandbox clears in about half an
 * hour; `clearAfterMs` sets how long here (0: at once).
 */
export class FakeIssuingApi implements IssuingApi, CardChargeSimulator {
  readonly cardholders = new Map<string, Cardholder>();
  readonly cards = new Map<string, FakeCard>();
  readonly transactions = new Map<string, CardTransaction[]>();
  private serial = 0;

  constructor(
    private readonly balances: Map<string, number> = new Map(),
    private readonly now: () => Date = () => new Date(),
    private readonly clearAfterMs = 0,
  ) {}

  async listCardholders(): Promise<Cardholder[]> {
    return [...this.cardholders.values()];
  }

  async createDelegateCardholder(email: string): Promise<Cardholder> {
    const cardholder: Cardholder = { cardholder_id: crypto.randomUUID(), status: "READY", type: "DELEGATE", email };
    this.cardholders.set(cardholder.cardholder_id, cardholder);
    return cardholder;
  }

  async createCard(request: CreateCardRequest): Promise<IssuedCard> {
    if (!this.cardholders.has(request.cardholderId)) throw new AwxHttpError(400, "invalid_argument", "cardholder not found", {});
    // A replayed request_id answers with the card it already made, as Airwallex ignores the repeat.
    const repeat = [...this.cards.values()].find((c) => c.requestId === request.requestId);
    if (repeat) return structuredClone(repeat.card);
    this.serial += 1;
    const last4 = String(4000 + ((this.serial * 7919) % 6000)).padStart(4, "0");
    const { controls } = request;
    const card: IssuedCard = {
      card_id: crypto.randomUUID(),
      card_status: "ACTIVE",
      card_number: `************${last4}`,
      brand: "VISA",
      nick_name: request.nickName,
      cardholder_id: request.cardholderId,
      created_at: this.now().toISOString(),
      form_factor: "VIRTUAL",
      authorization_controls: {
        allowed_transaction_count: controls.singleUse ? "SINGLE" : "MULTIPLE",
        allowed_merchant_categories: [...controls.merchantCategories],
        allowed_currencies: [controls.currency],
        active_to: controls.activeTo,
        transaction_limits: {
          currency: controls.currency,
          limits: [
            { amount: controls.limit, interval: "PER_TRANSACTION" },
            { amount: controls.limit, interval: "ALL_TIME" },
          ],
        },
      },
    };
    this.cards.set(card.card_id, { card, requestId: request.requestId, spent: 0 });
    this.transactions.set(card.card_id, []);
    return structuredClone(card);
  }

  async getCard(cardId: string): Promise<IssuedCard> {
    return structuredClone(this.require(cardId).card);
  }

  async findCardByNickName(cardholderId: string, nickName: string): Promise<IssuedCard | null> {
    const found = [...this.cards.values()].find((c) => c.card.cardholder_id === cardholderId && c.card.nick_name === nickName);
    return found ? structuredClone(found.card) : null;
  }

  async updateCardStatus(cardId: string, status: CardStatus): Promise<IssuedCard> {
    const entry = this.require(cardId);
    if (entry.card.card_status === "CLOSED") throw new AwxHttpError(400, "invalid_argument", "a closed card cannot change status", {});
    entry.card.card_status = status;
    return structuredClone(entry.card);
  }

  async listCardTransactions(cardId: string): Promise<CardTransaction[]> {
    this.require(cardId);
    const now = this.now().getTime();
    return (this.transactions.get(cardId) ?? []).map((tx) => {
      const copy = structuredClone(tx);
      // An approved purchase clears once its time has come; until then Airwallex reports it PENDING.
      if (copy.status === "APPROVED" && Date.parse(copy.transaction_date!) + this.clearAfterMs > now) copy.status = "PENDING";
      return copy;
    });
  }

  async charge(input: { cardId: string; amount: number; currency: string; merchantCategoryCode: string; merchantName: string }): Promise<SimulatedCharge> {
    const entry = this.require(input.cardId);
    const failure = this.decline(entry, input);
    const transaction: CardTransaction = {
      transaction_id: crypto.randomUUID(),
      card_id: input.cardId,
      transaction_type: failure ? "AUTHORIZATION" : "CLEARING",
      status: failure ? "FAILED" : "APPROVED",
      transaction_amount: -input.amount,
      transaction_currency: input.currency,
      billing_amount: -input.amount,
      billing_currency: input.currency,
      failure_reason: failure,
      merchant: { name: input.merchantName, category_code: input.merchantCategoryCode },
      transaction_date: this.now().toISOString(),
    };
    this.transactions.get(input.cardId)!.push(transaction);
    if (!failure) {
      entry.spent += input.amount;
      this.balances.set(input.currency, (this.balances.get(input.currency) ?? 1_000_000) - input.amount);
      if (entry.card.authorization_controls?.allowed_transaction_count === "SINGLE") entry.card.card_status = "CLOSED";
    }
    return {
      card_transaction_id: transaction.transaction_id,
      card_transaction_lifecycle_id: crypto.randomUUID(),
      process_result: failure ? "DECLINED" : "APPROVED",
      failure_reason: failure,
      transaction_amount: input.amount,
      transaction_currency: input.currency,
      type: transaction.transaction_type,
    };
  }

  private decline(entry: FakeCard, input: { amount: number; currency: string; merchantCategoryCode: string }): string | null {
    const { card } = entry;
    const controls = card.authorization_controls;
    if (card.card_status === "CLOSED") return "CARD_CLOSED";
    if (card.card_status !== "ACTIVE") return "CARD_INACTIVE";
    if (controls?.active_to && Date.parse(controls.active_to) < this.now().getTime()) return "OUT_OF_ALLOWED_TIME_RANGE";
    const currencies = controls?.allowed_currencies ?? [];
    if (currencies.length > 0 && !currencies.includes(input.currency)) return "CURRENCY_NOT_ALLOWED";
    const categories = controls?.allowed_merchant_categories ?? [];
    if (categories.length > 0 && !categories.includes(input.merchantCategoryCode)) return "MERCHANT_CATEGORY_NOT_ALLOWED";
    for (const limit of controls?.transaction_limits?.limits ?? []) {
      if (limit.interval === "PER_TRANSACTION" && input.amount > limit.amount) return "LIMIT_EXCEEDED";
      if (limit.interval === "ALL_TIME" && entry.spent + input.amount > limit.amount) return "LIMIT_EXCEEDED";
    }
    if ((this.balances.get(input.currency) ?? 1_000_000) < input.amount) return "INSUFFICIENT_FUNDS";
    return null;
  }

  private require(cardId: string): FakeCard {
    const entry = this.cards.get(cardId);
    if (!entry) throw new AwxHttpError(404, "not_found", "card not found", {});
    return entry;
  }
}
