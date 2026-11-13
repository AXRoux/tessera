/**
 * Airwallex Issuing: Visa virtual cards, as the REST API returns them (checked against the sandbox on 2026-11-13).
 *
 * Tessera issues one card per approved purchase, to a DELEGATE cardholder that stands for "the agents of this business"
 * (a delegate needs only an email and is READY at once). Cards are commercial, virtual, non-personalised and Visa
 * (Airwallex's default brand), and carry the spend controls a person signed: a currency, a cap, merchant categories, a
 * single use and an end date. Airwallex enforces those controls at authorisation; Tessera records what happened.
 */
import { z } from "zod";

export const CardholderSchema = z.looseObject({
  cardholder_id: z.string(),
  status: z.string(),
  type: z.string().optional(),
  email: z.string().optional(),
});
export type Cardholder = z.infer<typeof CardholderSchema>;
export const CardholderListSchema = z.looseObject({ items: z.array(CardholderSchema), has_more: z.boolean().optional() });

const LimitSchema = z.looseObject({ amount: z.number(), interval: z.string() });

export const IssuedCardSchema = z.looseObject({
  card_id: z.string(),
  card_status: z.string(),
  /** Masked, e.g. `************4111`. Tessera never asks for the full number. */
  card_number: z.string().nullish(),
  brand: z.string().nullish(),
  nick_name: z.string().nullish(),
  cardholder_id: z.string().nullish(),
  created_at: z.string().nullish(),
  form_factor: z.string().nullish(),
  authorization_controls: z
    .looseObject({
      allowed_transaction_count: z.string().nullish(),
      allowed_merchant_categories: z.array(z.string()).nullish(),
      allowed_currencies: z.array(z.string()).nullish(),
      active_to: z.string().nullish(),
      transaction_limits: z.looseObject({ currency: z.string().nullish(), limits: z.array(LimitSchema).nullish() }).nullish(),
    })
    .nullish(),
});
export type IssuedCard = z.infer<typeof IssuedCardSchema>;
export const IssuedCardListSchema = z.looseObject({ items: z.array(IssuedCardSchema), has_more: z.boolean().optional() });

/** One card transaction as `GET /api/v1/issuing/transactions` lists it. */
export const CardTransactionSchema = z.looseObject({
  transaction_id: z.string(),
  card_id: z.string().nullish(),
  transaction_type: z.string().nullish(),
  status: z.string().nullish(),
  transaction_amount: z.number().nullish(),
  transaction_currency: z.string().nullish(),
  billing_amount: z.number().nullish(),
  billing_currency: z.string().nullish(),
  failure_reason: z.string().nullish(),
  merchant: z.looseObject({ name: z.string().nullish(), category_code: z.string().nullish() }).nullish(),
  transaction_date: z.string().nullish(),
});
export type CardTransaction = z.infer<typeof CardTransactionSchema>;
export const CardTransactionListSchema = z.looseObject({ items: z.array(CardTransactionSchema), has_more: z.boolean().optional() });

/** What the sandbox simulator answers for a simulated charge (`POST /api/v1/simulation/issuing/create`). */
export const SimulatedChargeSchema = z.looseObject({
  card_transaction_id: z.string().nullish(),
  card_transaction_lifecycle_id: z.string().nullish(),
  process_result: z.string().nullish(),
  failure_reason: z.string().nullish(),
  transaction_amount: z.number().nullish(),
  transaction_currency: z.string().nullish(),
  type: z.string().nullish(),
});
export type SimulatedCharge = z.infer<typeof SimulatedChargeSchema>;

export type CardStatus = "ACTIVE" | "INACTIVE" | "CLOSED";

/** The controls a person signed, in the shape Tessera hands Airwallex. Amounts are major units, like every Airwallex amount. */
export interface CardControls {
  currency: string;
  /** The most one charge may be, and (as ALL_TIME) the most the card may ever spend. */
  limit: number;
  /** Visa merchant category codes the card may be used at. */
  merchantCategories: string[];
  singleUse: boolean;
  /** ISO 8601; the card refuses everything after it. */
  activeTo: string;
}

export interface CreateCardRequest {
  requestId: string;
  cardholderId: string;
  /** Who asked for it, as Airwallex records "created by". */
  createdBy: string;
  /** Shown in Airwallex's own web app beside the card; Tessera writes its card id here so a lost reply can be matched. */
  nickName: string;
  controls: CardControls;
}

/** Everything Tessera does with Airwallex Issuing. Real (`AirwallexClient`) or simulated (`FakeIssuingApi`). */
export interface IssuingApi {
  listCardholders(): Promise<Cardholder[]>;
  /** A DELEGATE cardholder: an email, no person behind it. Not retried: the caller looks for one first. */
  createDelegateCardholder(email: string): Promise<Cardholder>;
  /** Not retried: the caller records its intent first and matches a lost reply by nickname (`findCardByNickName`). */
  createCard(request: CreateCardRequest): Promise<IssuedCard>;
  getCard(cardId: string): Promise<IssuedCard>;
  findCardByNickName(cardholderId: string, nickName: string): Promise<IssuedCard | null>;
  updateCardStatus(cardId: string, status: CardStatus): Promise<IssuedCard>;
  listCardTransactions(cardId: string): Promise<CardTransaction[]>;
}

/** Sandbox (or offline) only: a merchant charges a card, authorisation and clearing in one step. */
export interface CardChargeSimulator {
  charge(input: { cardId: string; amount: number; currency: string; merchantCategoryCode: string; merchantName: string }): Promise<SimulatedCharge>;
}

/** Last four digits of a masked card number, or null when Airwallex has not shown one. */
export function lastFour(masked: string | null | undefined): string | null {
  const digits = masked?.replace(/\D/g, "") ?? "";
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/** Airwallex's `merchant_info` is exactly 43 characters. */
export function merchantInfo(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, " ").slice(0, 43).padEnd(43, " ");
}
