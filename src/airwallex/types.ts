import { z } from "zod";

export type TransferMethod = "LOCAL" | "SWIFT";

/** Only fields the gateway reads are declared; unknown fields pass through. */
export const TransferSchema = z.looseObject({
  id: z.string(),
  request_id: z.string().optional(),
  status: z.string(),
  beneficiary_id: z.string(),
  transfer_amount: z.number(),
  transfer_currency: z.string(),
  source_currency: z.string().optional(),
  transfer_method: z.string().optional(),
  fee_amount: z.number().default(0),
  fee_currency: z.string().optional(),
  amount_payer_pays: z.number().optional(),
  reference: z.string().optional(),
  short_reference_id: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  failure: z
    .object({ code: z.string(), message: z.string().optional(), details: z.unknown().optional() })
    .nullish(),
});
export type Transfer = z.infer<typeof TransferSchema>;

/** One page of transfers. `page_after` is the cursor for the next page; absent or null on the last one. */
export const TransferListSchema = z.looseObject({ items: z.array(TransferSchema), page_after: z.string().nullish() });

export interface CreateTransferRequest {
  request_id: string;
  beneficiary_id: string;
  source_currency: string;
  transfer_currency: string;
  transfer_amount: number;
  transfer_method: TransferMethod;
  reason: string;
  reference: string;
}

/** A definite HTTP answer from Airwallex. 4xx (except 408/429) means the request was not processed. */
export class AwxHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: unknown,
    /** From a 429's Retry-After header: how long Airwallex asked us to wait. */
    readonly retryAfterMs?: number,
  ) {
    super(`${status} ${code}: ${message}`);
    this.name = "AwxHttpError";
  }
}

/** The outcome is unknown: timeout, connection loss, or an unreadable response. */
export class AwxNetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AwxNetworkError";
  }
}

/** The slice of Airwallex the payout gateway depends on. */
export interface PayoutApi {
  createTransfer(request: CreateTransferRequest): Promise<Transfer>;
  getTransfer(id: string): Promise<Transfer>;
  /**
   * The transfer created under `requestId`, if any. Airwallex searches only the last 30 days unless told otherwise, so
   * callers pass `fromCreatedAt` (ISO 8601) at least as old as the intent: a lookup that misses a transfer because it
   * is outside the default window would prove nothing.
   */
  findTransferByRequestId(requestId: string, fromCreatedAt?: string): Promise<Transfer | null>;
}

/** One wallet line. `net` is the signed effect on the balance (payouts negative, reversals positive). */
export const FinancialTransactionSchema = z.looseObject({
  id: z.string(),
  source_id: z.string().nullish(),
  source_type: z.string().nullish(),
  transaction_type: z.string(),
  currency: z.string(),
  amount: z.number(),
  net: z.number(),
  fee: z.number().default(0),
  status: z.string(),
  description: z.string().nullish(),
  created_at: z.string().optional(),
});
export type FinancialTransaction = z.infer<typeof FinancialTransactionSchema>;

export const FinancialTransactionListSchema = z.looseObject({ items: z.array(FinancialTransactionSchema) });

/** What the Closer reads from Airwallex: wallet lines for one transfer, and recent transfers (to spot untracked ones). */
export interface ReconciliationApi {
  listFinancialTransactions(sourceId: string): Promise<FinancialTransaction[]>;
  listTransfers(fromCreatedAt: string): Promise<Transfer[]>;
}

/** One wallet as `GET /api/v1/balances/current` lists it (a bare array, one row per currency, zero rows included). */
export const WalletBalanceSchema = z.looseObject({ currency: z.string(), available_amount: z.number() });
export type WalletBalance = z.infer<typeof WalletBalanceSchema>;
export const BalanceListSchema = z.array(WalletBalanceSchema);

/** Spendable wallet balances in major units, every currency at once. The Commander reads them before it proposes a replacement or a conversion. */
export interface BalanceApi {
  getBalances(): Promise<WalletBalance[]>;
}

/**
 * Airwallex stamps FX times as `2026-11-03T14:57:22+0000` (no colon in the offset). Normalized to ISO 8601 UTC so every
 * reader (Bun, Node, the browser) parses them the same way. An unparseable time is an unreadable response, not a guess.
 */
const AwxTime = z.string().transform((value, ctx) => {
  const at = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  if (Number.isNaN(at)) {
    ctx.addIssue({ code: "custom", message: `unreadable time ${value}` });
    return z.NEVER;
  }
  return new Date(at).toISOString();
});

/**
 * An indicative rate (`GET /api/v1/fx/rates/current`). No quote id: it guarantees nothing and is only used to plan.
 * `rate` is the client rate for `currency_pair` in market convention (EURUSD = US dollars per euro).
 * https://www.airwallex.com/docs/api/transactional_fx/rates/current.md
 */
export const FxRateSchema = z.looseObject({
  buy_currency: z.string(),
  sell_currency: z.string(),
  currency_pair: z.string(),
  rate: z.number().positive(),
});
export type FxRate = z.infer<typeof FxRateSchema>;

/**
 * A quote (`POST /api/v1/fx/quotes/create`): a rate Airwallex guarantees until `valid_to_at`. The sandbox reports
 * `usage: MULTI_USE` and accepts one quote for several conversions (verified 2026-11-03), so Tessera makes it single-use
 * itself (a unique column), as the builder guide asks. https://www.airwallex.com/docs/api/transactional_fx/quotes/create.md
 */
export const FxQuoteSchema = z.looseObject({
  quote_id: z.string(),
  buy_currency: z.string(),
  sell_currency: z.string(),
  buy_amount: z.number().positive(),
  sell_amount: z.number().positive(),
  client_rate: z.number().positive(),
  currency_pair: z.string(),
  valid_from_at: AwxTime,
  valid_to_at: AwxTime,
  usage: z.string().optional(),
});
export type FxQuote = z.infer<typeof FxQuoteSchema>;

/**
 * A conversion (`POST /api/v1/fx/conversions/create`, `GET /api/v1/fx/conversions/{id}`). Status is SCHEDULED, SETTLED,
 * OVERDUE or CANCELLED; the sandbox answers SETTLED at once. https://www.airwallex.com/docs/api/transactional_fx/conversion/create.md
 */
export const ConversionSchema = z.looseObject({
  conversion_id: z.string(),
  request_id: z.string().optional(),
  quote_id: z.string().nullish(),
  status: z.string(),
  buy_currency: z.string(),
  sell_currency: z.string(),
  buy_amount: z.number(),
  sell_amount: z.number(),
  client_rate: z.number().optional(),
  currency_pair: z.string().optional(),
  short_reference_id: z.string().optional(),
  created_at: AwxTime.optional(),
  updated_at: AwxTime.optional(),
});
export type Conversion = z.infer<typeof ConversionSchema>;

export const ConversionListSchema = z.looseObject({ items: z.array(ConversionSchema), has_more: z.boolean().optional() });

/** Quote validity Airwallex offers. The agent's own path uses MIN_1; a person reviewing a quote gets MIN_15. */
export type QuoteValidity = "MIN_1" | "MIN_15" | "MIN_30" | "HR_1";

export interface CreateQuoteRequest {
  buy_currency: string;
  sell_currency: string;
  /** The dealt (fixed) side: Tessera always fixes what it must buy and lets Airwallex price the sell side. */
  buy_amount: number;
  validity: QuoteValidity;
}

export interface CreateConversionRequest {
  request_id: string;
  quote_id: string;
  buy_currency: string;
  sell_currency: string;
  buy_amount: number;
}

/**
 * The slice of Airwallex the funding executor depends on. `x-api-version` is never sent: the account's stored version
 * applies, and a stale header earns `incorrect_version` (builder guide, "Booking an FX conversion").
 */
export interface FxApi {
  getRate(buyCurrency: string, sellCurrency: string, buyAmount: number): Promise<FxRate>;
  createQuote(request: CreateQuoteRequest): Promise<FxQuote>;
  createConversion(request: CreateConversionRequest): Promise<Conversion>;
  getConversion(id: string): Promise<Conversion>;
  /** The conversion created under `requestId`, if any. Airwallex searches 31 days unless told otherwise, so pass `fromCreatedAt`. */
  findConversionByRequestId(requestId: string, fromCreatedAt?: string): Promise<Conversion | null>;
}

/**
 * How many units of `sellCurrency` one unit of `buyCurrency` costs at `rate`, quoted for `pair` in market convention:
 * EURUSD 1.13 means a euro costs 1.13 dollars, so buying EUR with USD multiplies and buying USD with EUR divides.
 */
export function sellPerBuy(pair: string, buyCurrency: string, sellCurrency: string, rate: number): number {
  if (pair === `${buyCurrency}${sellCurrency}`) return rate;
  if (pair === `${sellCurrency}${buyCurrency}`) return 1 / rate;
  throw new AwxNetworkError(`currency pair ${pair} does not match ${buyCurrency}/${sellCurrency}`);
}

export interface Beneficiary {
  id: string;
  nickname?: string;
}

/** A US company account paid by LOCAL (ACH) transfer in USD. */
export interface NewUsBeneficiary {
  nickname: string;
  companyName: string;
  accountNumber: string;
  /** ABA routing number. */
  routingNumber: string;
}

/** The sandbox supplier the demos pay; account and ABA routing number are from Airwallex's create-beneficiary example. */
export const SPIKE_SUPPLIER: NewUsBeneficiary = {
  nickname: "spike-us-supplier",
  companyName: "Spike Supplies Inc",
  accountNumber: "50001121",
  routingNumber: "021000021",
};

/** A German company account paid by SWIFT in EUR. */
export interface NewEuBeneficiary {
  nickname: string;
  companyName: string;
  iban: string;
  swiftCode: string;
}

/** The EUR sandbox supplier. A synthetic IBAN with a valid checksum (the standard DE example) and a real-format BIC. */
export const SPIKE_EU_SUPPLIER: NewEuBeneficiary = {
  nickname: "spike-eu-supplier",
  companyName: "Spike Lieferungen GmbH",
  iban: "DE89370400440532013000",
  swiftCode: "COBADEFFXXX",
};

/** The two shapes `bun run setup` creates: US/USD/LOCAL and DE/EUR/SWIFT. */
export interface BeneficiaryApi {
  listBeneficiaries(): Promise<Beneficiary[]>;
  createBeneficiary(input: NewUsBeneficiary): Promise<Beneficiary>;
  createEuBeneficiary(input: NewEuBeneficiary): Promise<Beneficiary>;
}
