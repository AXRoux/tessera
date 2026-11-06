import failureCodes from "../../fixtures/failure-codes.json";
import {
  AwxHttpError,
  AwxNetworkError,
  sellPerBuy,
  type BalanceApi,
  type Beneficiary,
  type BeneficiaryApi,
  type Conversion,
  type CreateConversionRequest,
  type CreateQuoteRequest,
  type CreateTransferRequest,
  type FinancialTransaction,
  type FxApi,
  type FxQuote,
  type FxRate,
  type NewEuBeneficiary,
  type NewUsBeneficiary,
  type PayoutApi,
  type QuoteValidity,
  type ReconciliationApi,
  type Transfer,
  type WalletBalance,
} from "./types";

/** Sandbox failure_type -> failure code, as captured from the sandbox simulator. */
const FAILURES = new Map(failureCodes.map((row) => [row.failureType, row]));

export interface FakePayoutApiOptions {
  now?: () => Date;
  /** Transfers per page of `listTransfersPage`; the real API pages too, so callers must follow the cursor. */
  pageSize?: number;
  beneficiaries?: Beneficiary[];
  /**
   * Stamp `created_at`/`updated_at` at whole-second resolution without forcing them to increase, as Airwallex's docs
   * show: two snapshots taken in the same second then carry the same `updated_at`.
   */
  secondResolution?: boolean;
}

/** Airwallex searches only this far back when a transfer lookup gives no `from_created_at`. */
const DEFAULT_LOOKUP_WINDOW_MS = 30 * 24 * 3600_000;
/** What an unlisted wallet holds: well funded, so a test only names the wallets its story depends on. */
const DEFAULT_BALANCE = 1_000_000;
/** The wallets the sandbox pre-credits (sandbox settings); `getBalances` lists them even before they move. */
const LISTED_CURRENCIES = ["USD", "EUR", "GBP", "CNY"];
const VALIDITY_MS: Record<QuoteValidity, number> = { MIN_1: 60_000, MIN_15: 15 * 60_000, MIN_30: 30 * 60_000, HR_1: 3600_000 };
/**
 * Client rates per pair in market convention, fixed so tests and the offline demo are deterministic. EURUSD is the rate
 * the sandbox quoted on 2026-11-03 (it did not move across a morning of calls).
 */
export const FAKE_FX_RATES: Readonly<Record<string, number>> = { EURUSD: 1.130824, GBPUSD: 1.312455, EURGBP: 0.861612 };

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * In-memory Airwallex with the behaviors the gateway and Closer depend on, verified against the real sandbox:
 * request_id dedupe (400 duplicate_request_id carrying the existing id), lookup by request_id, 404 on unknown ids,
 * fees read from the response, wallet lines per transfer (PAYOUT and FEE on create, PAYOUT_REVERSAL on CANCELLED),
 * `created_at`/`updated_at` on every snapshot, and cursor-paged transfer listing. `advance` plays the sandbox
 * simulator, so the offline demo runs on this too. Faults count down per call.
 *
 * Wallets move with the money: a transfer takes amount plus fee when it is created, a cancellation returns the amount
 * (the fee is kept), and a conversion moves both legs at once. FX behaves as observed on the sandbox on 2026-11-03:
 * quotes expire (`expired_quote`), are MULTI_USE (so single use is Tessera's job), a reused conversion request_id is
 * `400 invalid_argument` naming no conversion, an unknown conversion id is `400 not_found`, a short sell wallet is
 * `400 insufficient_funds`, and a conversion settles at once with CONVERSION_BUY and CONVERSION_SELL wallet lines.
 */
export class FakePayoutApi implements PayoutApi, ReconciliationApi, BalanceApi, BeneficiaryApi, FxApi {
  readonly transfers = new Map<string, Transfer>();
  /** Wallet lines by transfer id. Tests may edit these to simulate a booking Airwallex got wrong. */
  readonly wallet = new Map<string, FinancialTransaction[]>();
  /** Available balance per currency in major units. Unlisted currencies are well funded. */
  readonly balances = new Map<string, number>();
  readonly beneficiaries: Beneficiary[];
  /** What a payout costs by method, read back from the transfer like the real one. Tests change it: nothing may hardcode a fee. */
  readonly fees: Record<"LOCAL" | "SWIFT", number> = { LOCAL: 3, SWIFT: 13.33 };
  /** Client rates by pair (market convention). Tests move them to make a quote drift from the plan. */
  readonly rates = new Map<string, number>(Object.entries(FAKE_FX_RATES));
  readonly quotes = new Map<string, FxQuote>();
  readonly conversions = new Map<string, Conversion>();
  /** Status a new conversion gets. The sandbox settles at once; SCHEDULED plays an account that settles later (see `settleConversion`). */
  conversionStatus: "SETTLED" | "SCHEDULED" = "SETTLED";
  private readonly byRequest = new Map<string, string>();
  private readonly conversionsByRequest = new Map<string, string>();
  private readonly now: () => Date;
  private readonly pageSize: number;
  private readonly secondResolution: boolean;
  private lastStamp = 0;
  createCalls = 0;
  conversionCalls = 0;
  faults = {
    failBeforeCreate: 0, loseResponseAfterCreate: 0, rejectCreate: 0, failLookup: 0, rateLimitCreate: 0,
    /** Conversions: refused before booking, booked but the answer lost, 429, a failing lookup, unreadable balances. */
    failBeforeConversion: 0, loseConversionResponse: 0, rateLimitConversion: 0, failConversionLookup: 0, failBalances: 0,
  };
  /** Retry-After a rate-limited create reports, in ms. */
  rateLimitRetryAfterMs = 1_000;
  /** Every `findTransferByRequestId` call: the request_id and the `from_created_at` it was given. */
  readonly lookups: Array<{ requestId: string; fromCreatedAt: string | undefined }> = [];

  constructor(options: FakePayoutApiOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.pageSize = options.pageSize ?? 100;
    this.secondResolution = options.secondResolution ?? false;
    this.beneficiaries = options.beneficiaries ?? [
      { id: "ben-A", nickname: "spike-us-supplier" },
      { id: "ben-B", nickname: "spike-us-supplier-alt" },
    ];
  }

  get all(): Transfer[] {
    return [...this.transfers.values()];
  }

  async createTransfer(request: CreateTransferRequest): Promise<Transfer> {
    this.createCalls++;
    if (this.faults.rateLimitCreate > 0) {
      this.faults.rateLimitCreate--;
      throw new AwxHttpError(429, "too_many_requests", "rate limit exceeded", { code: "too_many_requests" }, this.rateLimitRetryAfterMs);
    }
    if (this.faults.failBeforeCreate > 0) {
      this.faults.failBeforeCreate--;
      throw new AwxNetworkError("connection refused");
    }
    const existing = this.byRequest.get(request.request_id);
    if (existing) {
      throw new AwxHttpError(400, "duplicate_request_id", "request id used before", {
        code: "duplicate_request_id",
        details: { id: existing, request_id: request.request_id },
      });
    }
    if (this.faults.rejectCreate > 0) {
      this.faults.rejectCreate--;
      throw new AwxHttpError(400, "validation_failed", "schema validation failed", { code: "validation_failed" });
    }

    const fee = this.fees[request.transfer_method];
    // Builder guide, "Sandbox constraints": transfers/create answers `balance_insufficient` when the wallet is short.
    if (this.balanceOf(request.source_currency) < request.transfer_amount + fee) {
      throw new AwxHttpError(400, "balance_insufficient", "insufficient balance", { code: "balance_insufficient" });
    }
    const stamp = this.stamp();
    const transfer: Transfer = {
      id: crypto.randomUUID(),
      request_id: request.request_id,
      status: "PROCESSING",
      beneficiary_id: request.beneficiary_id,
      transfer_amount: request.transfer_amount,
      transfer_currency: request.transfer_currency,
      source_currency: request.source_currency,
      transfer_method: request.transfer_method,
      fee_amount: fee,
      fee_currency: request.transfer_currency,
      amount_payer_pays: Math.round((request.transfer_amount + fee) * 100) / 100,
      reference: request.reference,
      created_at: stamp,
      updated_at: stamp,
    };
    this.transfers.set(transfer.id, transfer);
    this.byRequest.set(request.request_id, transfer.id);
    this.book(transfer, "PAYOUT", -transfer.transfer_amount);
    this.book(transfer, "FEE", -fee);
    this.move(request.source_currency, -(request.transfer_amount + fee));

    if (this.faults.loseResponseAfterCreate > 0) {
      this.faults.loseResponseAfterCreate--;
      throw new AwxNetworkError("timeout waiting for response");
    }
    return structuredClone(transfer);
  }

  async getTransfer(id: string): Promise<Transfer> {
    const transfer = this.transfers.get(id);
    if (!transfer) throw new AwxHttpError(404, "not_found", "Transfer not found", { code: "not_found" });
    return structuredClone(transfer);
  }

  async findTransferByRequestId(requestId: string, fromCreatedAt?: string): Promise<Transfer | null> {
    this.lookups.push({ requestId, fromCreatedAt });
    if (this.faults.failLookup > 0) {
      this.faults.failLookup--;
      throw new AwxNetworkError("lookup timed out");
    }
    const id = this.byRequest.get(requestId);
    const transfer = id ? this.transfers.get(id) : undefined;
    if (!transfer) return null;
    // Like the real search: older than the window (30 days unless the caller reaches further back) is not found.
    const from = fromCreatedAt === undefined ? this.now().getTime() - DEFAULT_LOOKUP_WINDOW_MS : Date.parse(fromCreatedAt);
    if (transfer.created_at !== undefined && Date.parse(transfer.created_at) < from) return null;
    return structuredClone(transfer);
  }

  /**
   * The sandbox simulator: moves a transfer to `status`. `failureType` is a sandbox failure_type (mapped to its
   * captured failure code) or a failure code itself.
   */
  advance(transferId: string, status: string, failureType?: string): void {
    const transfer = this.transfers.get(transferId);
    if (!transfer) throw new Error(`unknown transfer ${transferId}`);
    const previous = transfer.status;
    transfer.status = status;
    transfer.updated_at = this.stamp();
    if (failureType) {
      const known = FAILURES.get(failureType);
      transfer.failure = { code: known?.code ?? failureType, message: known?.message ?? "simulated failure" };
    }
    if (status === "CANCELLED") this.book(transfer, "PAYOUT_REVERSAL", transfer.transfer_amount);
    // The amount comes back to the wallet; the fee does not (observed on the sandbox, see SPEC.md).
    if (status === "CANCELLED" && previous !== "CANCELLED") this.move(transfer.source_currency ?? transfer.transfer_currency, transfer.transfer_amount);
  }

  async listFinancialTransactions(sourceId: string): Promise<FinancialTransaction[]> {
    return structuredClone(this.wallet.get(sourceId) ?? []);
  }

  /** One page of transfers created at or after `fromCreatedAt`, oldest first; `page` is the previous `page_after`. */
  listTransfersPage(fromCreatedAt: string, page?: string): { items: Transfer[]; page_after: string | null } {
    const from = Date.parse(fromCreatedAt);
    const matching = this.all.filter((t) => t.created_at === undefined || Date.parse(t.created_at) >= from);
    const start = page === undefined ? 0 : Number(page);
    const end = start + this.pageSize;
    return { items: structuredClone(matching.slice(start, end)), page_after: end < matching.length ? String(end) : null };
  }

  async listTransfers(fromCreatedAt: string): Promise<Transfer[]> {
    const transfers: Transfer[] = [];
    let cursor: string | undefined;
    for (;;) {
      const { items, page_after } = this.listTransfersPage(fromCreatedAt, cursor);
      transfers.push(...items);
      if (page_after === null) return transfers;
      cursor = page_after;
    }
  }

  async getBalances(): Promise<WalletBalance[]> {
    if (this.faults.failBalances > 0) {
      this.faults.failBalances--;
      throw new AwxNetworkError("balances timed out");
    }
    const currencies = new Set([...LISTED_CURRENCIES, ...this.balances.keys()]);
    return [...currencies].map((currency) => ({ currency, available_amount: this.balanceOf(currency) }));
  }

  // ---- FX ---------------------------------------------------------------------------------------------------

  async getRate(buyCurrency: string, sellCurrency: string, _buyAmount: number): Promise<FxRate> {
    const pair = this.pairFor(buyCurrency, sellCurrency);
    return { buy_currency: buyCurrency, sell_currency: sellCurrency, currency_pair: pair, rate: this.rates.get(pair)! };
  }

  async createQuote(request: CreateQuoteRequest): Promise<FxQuote> {
    const pair = this.pairFor(request.buy_currency, request.sell_currency);
    const rate = this.rates.get(pair)!;
    const from = this.now();
    const quote: FxQuote = {
      quote_id: crypto.randomUUID(),
      buy_currency: request.buy_currency,
      sell_currency: request.sell_currency,
      buy_amount: request.buy_amount,
      sell_amount: round2(request.buy_amount * sellPerBuy(pair, request.buy_currency, request.sell_currency, rate)),
      client_rate: rate,
      currency_pair: pair,
      valid_from_at: from.toISOString(),
      valid_to_at: new Date(from.getTime() + VALIDITY_MS[request.validity]).toISOString(),
      usage: "MULTI_USE",
    };
    this.quotes.set(quote.quote_id, quote);
    return structuredClone(quote);
  }

  async createConversion(request: CreateConversionRequest): Promise<Conversion> {
    this.conversionCalls++;
    if (this.faults.rateLimitConversion > 0) {
      this.faults.rateLimitConversion--;
      throw new AwxHttpError(429, "too_many_requests", "rate limit exceeded", { code: "too_many_requests" }, this.rateLimitRetryAfterMs);
    }
    if (this.faults.failBeforeConversion > 0) {
      this.faults.failBeforeConversion--;
      throw new AwxNetworkError("connection refused");
    }
    if (this.conversionsByRequest.has(request.request_id)) {
      // As the sandbox answers it: no conversion id in the body, so the caller must look the request_id up.
      throw new AwxHttpError(400, "invalid_argument", `request_id '${request.request_id}' has been used in the past. Please use a different request_id for this request`, {
        code: "invalid_argument", source: "request_id",
      });
    }
    const quote = this.quotes.get(request.quote_id);
    if (!quote) throw new AwxHttpError(400, "invalid_quote_id", "Invalid quote id", { code: "invalid_quote_id", source: "quoteId" });
    if (Date.parse(quote.valid_to_at) < this.now().getTime()) {
      throw new AwxHttpError(400, "expired_quote", "Quote has expired", { code: "expired_quote", source: "quoteId" });
    }
    if (quote.buy_currency !== request.buy_currency || quote.sell_currency !== request.sell_currency) {
      throw new AwxHttpError(400, "conflict_original_ccy", "Quote currencies differ from currencies in execution request", { code: "conflict_original_ccy" });
    }
    const sell = round2(request.buy_amount * sellPerBuy(quote.currency_pair, quote.buy_currency, quote.sell_currency, quote.client_rate));
    if (this.balanceOf(request.sell_currency) < sell) {
      throw new AwxHttpError(400, "insufficient_funds", "insufficient_funds", { code: "insufficient_funds", source: "conversion" });
    }
    const stamp = this.stamp();
    const conversion: Conversion = {
      conversion_id: crypto.randomUUID(),
      request_id: request.request_id,
      quote_id: quote.quote_id,
      status: this.conversionStatus,
      buy_currency: request.buy_currency,
      sell_currency: request.sell_currency,
      buy_amount: request.buy_amount,
      sell_amount: sell,
      client_rate: quote.client_rate,
      currency_pair: quote.currency_pair,
      short_reference_id: `C${stamp.slice(2, 10).replaceAll("-", "")}-${request.request_id.slice(0, 7).toUpperCase()}`,
      created_at: stamp,
      updated_at: stamp,
    };
    this.conversions.set(conversion.conversion_id, conversion);
    this.conversionsByRequest.set(request.request_id, conversion.conversion_id);
    this.move(conversion.sell_currency, -conversion.sell_amount);
    if (conversion.status === "SETTLED") this.settleLegs(conversion);
    if (this.faults.loseConversionResponse > 0) {
      this.faults.loseConversionResponse--;
      throw new AwxNetworkError("timeout waiting for response");
    }
    return structuredClone(conversion);
  }

  async getConversion(id: string): Promise<Conversion> {
    const conversion = this.conversions.get(id);
    if (!conversion) throw new AwxHttpError(400, "not_found", "Specified resource id not found", { code: "not_found", source: id });
    return structuredClone(conversion);
  }

  async findConversionByRequestId(requestId: string, _fromCreatedAt?: string): Promise<Conversion | null> {
    if (this.faults.failConversionLookup > 0) {
      this.faults.failConversionLookup--;
      throw new AwxNetworkError("lookup timed out");
    }
    const id = this.conversionsByRequest.get(requestId);
    return id ? structuredClone(this.conversions.get(id)!) : null;
  }

  /** A SCHEDULED conversion settles: the bought currency lands and both wallet lines are booked. */
  settleConversion(conversionId: string): void {
    const conversion = this.conversions.get(conversionId);
    if (!conversion) throw new Error(`unknown conversion ${conversionId}`);
    if (conversion.status === "SETTLED") return;
    conversion.status = "SETTLED";
    conversion.updated_at = this.stamp();
    this.settleLegs(conversion);
  }

  /** The wallet as it stands, in major units. */
  balanceOf(currency: string): number {
    return this.balances.get(currency) ?? DEFAULT_BALANCE;
  }

  async listBeneficiaries(): Promise<Beneficiary[]> {
    return structuredClone(this.beneficiaries);
  }

  async createBeneficiary(input: NewUsBeneficiary): Promise<Beneficiary> {
    const beneficiary = { id: crypto.randomUUID(), nickname: input.nickname };
    this.beneficiaries.push(beneficiary);
    return structuredClone(beneficiary);
  }

  async createEuBeneficiary(input: NewEuBeneficiary): Promise<Beneficiary> {
    const beneficiary = { id: crypto.randomUUID(), nickname: input.nickname };
    this.beneficiaries.push(beneficiary);
    return structuredClone(beneficiary);
  }

  /** Books one wallet line against a transfer. */
  book(transfer: Transfer, type: string, net: number, status = "SETTLED"): void {
    this.line(transfer.id, type === "FEE" ? "FEE" : "PAYOUT", type, transfer.transfer_currency, net, status);
  }

  /** Books one wallet line against any source (a transfer or a conversion). */
  line(sourceId: string, sourceType: string, type: string, currency: string, net: number, status = "SETTLED"): void {
    const lines = this.wallet.get(sourceId) ?? [];
    lines.push({ id: crypto.randomUUID(), source_id: sourceId, source_type: sourceType, transaction_type: type, currency, amount: net, net, fee: 0, status });
    this.wallet.set(sourceId, lines);
  }

  private settleLegs(conversion: Conversion): void {
    this.move(conversion.buy_currency, conversion.buy_amount);
    this.line(conversion.conversion_id, "CONVERSION", "CONVERSION_BUY", conversion.buy_currency, conversion.buy_amount);
    this.line(conversion.conversion_id, "CONVERSION", "CONVERSION_SELL", conversion.sell_currency, -conversion.sell_amount);
  }

  private move(currency: string, delta: number): void {
    this.balances.set(currency, round2(this.balanceOf(currency) + delta));
  }

  /** The market-convention pair for two currencies, or the error the sandbox gives for a pair it does not quote. */
  private pairFor(buyCurrency: string, sellCurrency: string): string {
    for (const pair of [`${buyCurrency}${sellCurrency}`, `${sellCurrency}${buyCurrency}`]) if (this.rates.has(pair)) return pair;
    throw new AwxHttpError(400, "unsupported_currency", `no rate for ${buyCurrency}/${sellCurrency}`, { code: "unsupported_currency" });
  }

  /** Strictly increasing timestamps, so `updated_at` orders snapshots even within one millisecond (unless `secondResolution`). */
  private stamp(): string {
    if (this.secondResolution) {
      this.lastStamp = Math.max(Math.floor(this.now().getTime() / 1000) * 1000, this.lastStamp);
      return new Date(this.lastStamp).toISOString();
    }
    this.lastStamp = Math.max(this.now().getTime(), this.lastStamp + 1);
    return new Date(this.lastStamp).toISOString();
  }
}
