import { z } from "zod";
import {
  AwxHttpError,
  AwxNetworkError,
  BalanceListSchema,
  ConversionListSchema,
  ConversionSchema,
  FinancialTransactionListSchema,
  FxQuoteSchema,
  FxRateSchema,
  TransferListSchema,
  TransferSchema,
  type Beneficiary,
  type BeneficiaryApi,
  type Conversion,
  type CreateConversionRequest,
  type CreateQuoteRequest,
  type CreateTransferRequest,
  type FinancialTransaction,
  type BalanceApi,
  type FxApi,
  type FxQuote,
  type FxRate,
  type NewEuBeneficiary,
  type NewUsBeneficiary,
  type PayoutApi,
  type ReconciliationApi,
  type Transfer,
  type WalletBalance,
} from "./types";
import {
  CardholderListSchema,
  CardholderSchema,
  CardTransactionListSchema,
  IssuedCardListSchema,
  IssuedCardSchema,
  SimulatedChargeSchema,
  merchantInfo,
  type Cardholder,
  type CardChargeSimulator,
  type CardStatus,
  type CardTransaction,
  type CreateCardRequest,
  type IssuedCard,
  type IssuingApi,
  type SimulatedCharge,
} from "./issuing";

export interface ClientOptions {
  baseUrl: string;
  clientId: string;
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Sandbox allows 10 req/s per endpoint; 120ms spacing stays under it. */
  minIntervalMs?: number;
  /** Waits for pacing and retries. Tests pass a recorder. */
  sleep?: (ms: number) => Promise<void>;
}

const LoginSchema = z.object({ token: z.string() });
const ErrorBodySchema = z.looseObject({ code: z.string().optional(), message: z.string().optional() });
const BeneficiarySchema = z.looseObject({ id: z.string(), nickname: z.string().nullish() });
const BeneficiaryListSchema = z.looseObject({ items: z.array(BeneficiarySchema) });
const TOKEN_TTL_MS = 25 * 60_000; // tokens last 30 minutes
const WebhookSubscriptionSchema = z.looseObject({
  id: z.string(),
  url: z.string(),
  events: z.array(z.string()),
  version: z.string(),
  secret: z.string().optional(),
});
const WebhookListSchema = z.looseObject({ items: z.array(WebhookSubscriptionSchema), page_after: z.string().nullish() });

/** An Airwallex webhook subscription. `secret` signs every delivery to `url`; never log it. */
export type WebhookSubscription = z.infer<typeof WebhookSubscriptionSchema>;
const MAX_RETRY_WAIT_MS = 30_000;
/** Stops a cursor loop that never ends (a server bug), rather than paging forever. */
const MAX_PAGES = 500;

/** Retry-After is either delay-seconds or an HTTP date. */
function parseRetryAfter(header: string | null, now: number): number | undefined {
  if (header === null || header.trim() === "") return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** Airwallex writes card dates as `2026-11-20T00:00:00+0000`. */
const awxDate = (iso: string): string => `${new Date(iso).toISOString().slice(0, 19)}+0000`;

export class AirwallexClient implements PayoutApi, ReconciliationApi, BalanceApi, BeneficiaryApi, FxApi, IssuingApi, CardChargeSimulator {
  private token: { value: string; expiresAt: number } | null = null;
  /** The login in flight, shared by every caller that needs a token meanwhile (one login, not one per request). */
  private login: Promise<string> | null = null;
  private nextSlot = 0;

  constructor(private readonly opts: ClientOptions) {}

  static fromEnv(env: Record<string, string | undefined> = process.env): AirwallexClient {
    const clientId = env.AWX_CLIENT_ID;
    const apiKey = env.AWX_API_KEY;
    if (!clientId || !apiKey) throw new Error("AWX_CLIENT_ID and AWX_API_KEY must be set");
    return new AirwallexClient({ baseUrl: env.AWX_BASE_URL ?? "https://api.sandbox.airwallex.com", clientId, apiKey });
  }

  // ---- payout surface ------------------------------------------------------

  async createTransfer(request: CreateTransferRequest): Promise<Transfer> {
    const body = await this.request("POST", "/api/v1/transfers/create", { body: request });
    return this.parse(TransferSchema, body);
  }

  async getTransfer(id: string): Promise<Transfer> {
    return this.parse(TransferSchema, await this.request("GET", `/api/v1/transfers/${encodeURIComponent(id)}`));
  }

  async findTransferByRequestId(requestId: string, fromCreatedAt?: string): Promise<Transfer | null> {
    const query: Record<string, string> = { request_id: requestId };
    if (fromCreatedAt !== undefined) query.from_created_at = fromCreatedAt;
    const body = await this.request("GET", "/api/v1/transfers", { query });
    return this.parse(TransferListSchema, body).items[0] ?? null;
  }

  // ---- sandbox helpers (used by scenarios and the smoke scripts) -------------

  /**
   * Sandbox demos only: a spot conversion (no quote) that fixes either side, used to stage a wallet's balance before a demo
   * (`stageWalletOnSandbox`). Never on the funding path, which always fixes the bought amount against a quote.
   */
  async sandboxSpotConversion(
    request: { request_id: string; sell_currency: string; buy_currency: string } & ({ sell_amount: number } | { buy_amount: number }),
  ): Promise<Conversion> {
    if (!this.opts.baseUrl.includes("sandbox")) throw new Error("sandboxSpotConversion is for the Airwallex sandbox only");
    return this.parse(ConversionSchema, await this.request("POST", "/api/v1/fx/conversions/create", { body: request }));
  }

  /**
   * The sandbox simulator answers 500 operation_failed now and then. It is off the payout path (no money, no
   * request_id), so unlike every other POST here it is retried: a retry that races a step that did land gets a 4xx.
   */
  async simulateTransition(transferId: string, nextStatus: string, failureType?: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.request("POST", `/api/v1/simulation/transfers/${encodeURIComponent(transferId)}/transition`, {
          body: { next_status: nextStatus, ...(failureType ? { failure_type: failureType } : {}) },
        });
        return;
      } catch (error) {
        if (error instanceof AwxHttpError && error.status >= 500 && attempt < 3) {
          await this.sleep(900 * (attempt + 1));
          continue;
        }
        throw error;
      }
    }
  }

  async listBeneficiaries(): Promise<Beneficiary[]> {
    const body = await this.request("GET", "/api/v1/beneficiaries", { query: { page_size: "100" } });
    return this.parse(BeneficiaryListSchema, body).items.map((b) => ({ id: b.id, ...(b.nickname ? { nickname: b.nickname } : {}) }));
  }

  /**
   * Creates a US company beneficiary paid by LOCAL (ACH) in USD, for `bun run setup`. Not retried: a retry could
   * create two. Callers look the nickname up first.
   */
  async createBeneficiary(input: NewUsBeneficiary): Promise<Beneficiary> {
    const body = await this.request("POST", "/api/v1/beneficiaries/create", {
      body: {
        beneficiary: {
          entity_type: "COMPANY",
          company_name: input.companyName,
          address: { country_code: "US", city: "Seattle", state: "Washington", postcode: "98104", street_address: "412 5th Avenue" },
          bank_details: {
            account_currency: "USD",
            account_name: input.companyName,
            account_number: input.accountNumber,
            account_routing_type1: "aba",
            account_routing_value1: input.routingNumber,
            // Required for US ACH since late 2026 (Airwallex's schema: Checking|Savings); older businesses were never asked.
            bank_account_category: "Checking",
            bank_country_code: "US",
            local_clearing_system: "ACH",
          },
        },
        nickname: input.nickname,
        transfer_methods: ["LOCAL"],
      },
    });
    // The create response nests the record id at the top level next to `beneficiary`.
    const created = this.parse(z.looseObject({ id: z.string() }), body);
    return { id: created.id, nickname: input.nickname };
  }

  /** Creates a German company beneficiary paid by SWIFT in EUR, for `bun run setup`. Not retried, like the US one. */
  async createEuBeneficiary(input: NewEuBeneficiary): Promise<Beneficiary> {
    const body = await this.request("POST", "/api/v1/beneficiaries/create", {
      body: {
        beneficiary: {
          entity_type: "COMPANY",
          company_name: input.companyName,
          address: { country_code: "DE", city: "Berlin", postcode: "10115", street_address: "Invalidenstrasse 1" },
          bank_details: {
            account_currency: "EUR",
            account_name: input.companyName,
            iban: input.iban,
            swift_code: input.swiftCode,
            bank_country_code: "DE",
          },
        },
        nickname: input.nickname,
        transfer_methods: ["SWIFT"],
      },
    });
    const created = this.parse(z.looseObject({ id: z.string() }), body);
    return { id: created.id, nickname: input.nickname };
  }

  // ---- webhook subscriptions (used by `bun run webhook:register`, never by the API process) --------------------

  /**
   * Subscriptions can be managed over the API as well as in the web app (Settings > Developer > Webhooks):
   * https://www.airwallex.com/docs/api/webhooks/webhooks/create.md. Events and version are fixed at creation; only
   * the URL can be updated, and the secret survives an update.
   */
  async listWebhooks(): Promise<WebhookSubscription[]> {
    const subscriptions: WebhookSubscription[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query: Record<string, string> = { page_size: "100" };
      if (cursor !== null) query.page = cursor;
      const body = this.parse(WebhookListSchema, await this.request("GET", "/api/v1/webhooks", { query }));
      subscriptions.push(...body.items);
      const next = body.page_after ?? null;
      if (next === null || next === cursor || body.items.length === 0) return subscriptions;
      cursor = next;
    }
    throw new AwxNetworkError(`listing webhooks did not end after ${MAX_PAGES} pages`);
  }

  /** Not retried: `request_id` makes a resend safe, but the caller decides whether to resend. */
  async createWebhook(input: { url: string; events: string[]; version: string; requestId: string }): Promise<WebhookSubscription> {
    const body = await this.request("POST", "/api/v1/webhooks/create", {
      body: { url: input.url, events: input.events, version: input.version, request_id: input.requestId },
    });
    return this.parse(WebhookSubscriptionSchema, body);
  }

  async updateWebhookUrl(id: string, url: string): Promise<WebhookSubscription> {
    return this.parse(WebhookSubscriptionSchema, await this.request("POST", `/api/v1/webhooks/${encodeURIComponent(id)}/update`, { body: { url } }));
  }

  async deleteWebhook(id: string): Promise<void> {
    await this.request("POST", `/api/v1/webhooks/${encodeURIComponent(id)}/delete`);
  }

  /**
   * Every transfer created since `fromCreatedAt` (ISO 8601), following `page_after` to the last page. Used to prove
   * no duplicate exists for a reference, so stopping at page one would be a false "none found".
   */
  async listTransfers(fromCreatedAt: string): Promise<Transfer[]> {
    const transfers: Transfer[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query: Record<string, string> = { from_created_at: fromCreatedAt, page_size: "200" };
      if (cursor !== null) query.page = cursor;
      const body = this.parse(TransferListSchema, await this.request("GET", "/api/v1/transfers", { query }));
      transfers.push(...body.items);
      const next = body.page_after ?? null;
      if (next === null || next === cursor || body.items.length === 0) return transfers;
      cursor = next;
    }
    throw new AwxNetworkError(`listing transfers did not end after ${MAX_PAGES} pages`);
  }

  /** Wallet lines booked against one transfer (payout, fee, reversal). */
  async listFinancialTransactions(sourceId: string): Promise<FinancialTransaction[]> {
    const body = await this.request("GET", "/api/v1/financial_transactions", { query: { source_id: sourceId, page_size: "100" } });
    return this.parse(FinancialTransactionListSchema, body).items;
  }

  /** Every wallet's available balance, in major units (one call; Airwallex lists every currency, zero ones included). */
  async getBalances(): Promise<WalletBalance[]> {
    return this.parse(BalanceListSchema, await this.request("GET", "/api/v1/balances/current"));
  }

  // ---- FX (funding a replacement from another wallet) ----------------------

  /** Indicative only: no quote id, nothing guaranteed. Used to plan; the booking uses a quote. */
  async getRate(buyCurrency: string, sellCurrency: string, buyAmount: number): Promise<FxRate> {
    const query = { buy_currency: buyCurrency, sell_currency: sellCurrency, buy_amount: String(buyAmount) };
    return this.parse(FxRateSchema, await this.request("GET", "/api/v1/fx/rates/current", { query }));
  }

  /** A guaranteed rate until `valid_to_at`. A POST, so not retried here; a lost quote costs nothing but a fresh one. */
  async createQuote(request: CreateQuoteRequest): Promise<FxQuote> {
    return this.parse(FxQuoteSchema, await this.request("POST", "/api/v1/fx/quotes/create", { body: request }));
  }

  /**
   * Books a conversion. Never retried here: the funding executor owns the request_id and resolves an ambiguous answer
   * by looking the request_id up (`findConversionByRequestId`).
   */
  async createConversion(request: CreateConversionRequest): Promise<Conversion> {
    return this.parse(ConversionSchema, await this.request("POST", "/api/v1/fx/conversions/create", { body: request }));
  }

  async getConversion(id: string): Promise<Conversion> {
    return this.parse(ConversionSchema, await this.request("GET", `/api/v1/fx/conversions/${encodeURIComponent(id)}`));
  }

  async findConversionByRequestId(requestId: string, fromCreatedAt?: string): Promise<Conversion | null> {
    const query: Record<string, string> = { request_id: requestId };
    if (fromCreatedAt !== undefined) query.from_created_at = fromCreatedAt;
    const body = this.parse(ConversionListSchema, await this.request("GET", "/api/v1/fx/conversions", { query }));
    return body.items.find((c) => c.request_id === undefined || c.request_id === requestId) ?? null;
  }

  // ---- Issuing: Visa virtual cards ------------------------------------------

  async listCardholders(): Promise<Cardholder[]> {
    const body = await this.request("GET", "/api/v1/issuing/cardholders", { query: { page_size: "200" } });
    return this.parse(CardholderListSchema, body).items;
  }

  async createDelegateCardholder(email: string): Promise<Cardholder> {
    return this.parse(CardholderSchema, await this.request("POST", "/api/v1/issuing/cardholders/create", { body: { type: "DELEGATE", email } }));
  }

  /**
   * A commercial, virtual, non-personalised card on the account's default program (Visa). The controls are the whole
   * point: the cap twice (per charge and for the card's life), one currency, the merchant categories, single use, an end.
   */
  async createCard(request: CreateCardRequest): Promise<IssuedCard> {
    const { controls } = request;
    const body = await this.request("POST", "/api/v1/issuing/cards/create", {
      body: {
        request_id: request.requestId,
        cardholder_id: request.cardholderId,
        created_by: request.createdBy,
        form_factor: "VIRTUAL",
        is_personalized: false,
        program: { purpose: "COMMERCIAL" },
        purpose: "ONLINE_PURCHASING",
        nick_name: request.nickName,
        authorization_controls: {
          allowed_transaction_count: controls.singleUse ? "SINGLE" : "MULTIPLE",
          allowed_currencies: [controls.currency],
          allowed_merchant_categories: controls.merchantCategories,
          active_to: awxDate(controls.activeTo),
          transaction_limits: {
            currency: controls.currency,
            limits: [
              { amount: controls.limit, interval: "PER_TRANSACTION" },
              { amount: controls.limit, interval: "ALL_TIME" },
            ],
          },
        },
      },
    });
    return this.parse(IssuedCardSchema, body);
  }

  async getCard(cardId: string): Promise<IssuedCard> {
    return this.parse(IssuedCardSchema, await this.request("GET", `/api/v1/issuing/cards/${encodeURIComponent(cardId)}`));
  }

  /** The card a lost create reply made, found by the nickname Tessera wrote on it. */
  async findCardByNickName(cardholderId: string, nickName: string): Promise<IssuedCard | null> {
    for (let page = 0; page < 20; page++) {
      const body = this.parse(
        IssuedCardListSchema,
        await this.request("GET", "/api/v1/issuing/cards", { query: { cardholder_id: cardholderId, page_size: "200", page_num: String(page) } }),
      );
      const found = body.items.find((card) => card.nick_name === nickName);
      if (found) return found;
      if (!body.has_more || body.items.length === 0) return null;
    }
    return null;
  }

  async updateCardStatus(cardId: string, status: CardStatus): Promise<IssuedCard> {
    return this.parse(IssuedCardSchema, await this.request("POST", `/api/v1/issuing/cards/${encodeURIComponent(cardId)}/update`, { body: { card_status: status } }));
  }

  async listCardTransactions(cardId: string): Promise<CardTransaction[]> {
    const body = await this.request("GET", "/api/v1/issuing/transactions", { query: { card_id: cardId, page_size: "100" } });
    return this.parse(CardTransactionListSchema, body).items;
  }

  /** Sandbox only: a merchant charges the card, authorised and cleared in one step (`single_phase`). */
  async charge(input: { cardId: string; amount: number; currency: string; merchantCategoryCode: string; merchantName: string }): Promise<SimulatedCharge> {
    if (!this.opts.baseUrl.includes("sandbox")) throw new Error("simulated card charges exist only on the Airwallex sandbox");
    const body = await this.request("POST", "/api/v1/simulation/issuing/create", {
      body: {
        card_id: input.cardId,
        transaction_amount: input.amount,
        transaction_currency: input.currency,
        merchant_category_code: input.merchantCategoryCode,
        merchant_info: merchantInfo(input.merchantName),
        single_phase: true,
      },
    });
    return this.parse(SimulatedChargeSchema, body);
  }

  // ---- transport ------------------------------------------------------------

  /** A response that cannot be read is an unknown outcome, never a parse bug to ignore. */
  private parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
    const result = schema.safeParse(data);
    if (!result.success) throw new AwxNetworkError(`unexpected response shape: ${result.error.message}`);
    return result.data;
  }

  private async pace(): Promise<void> {
    const now = Date.now();
    const wait = this.nextSlot - now;
    this.nextSlot = Math.max(now, this.nextSlot) + (this.opts.minIntervalMs ?? 120);
    if (wait > 0) await this.sleep(wait);
  }

  /** One login at a time: concurrent callers with an expired token share the same request. */
  private ensureToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return Promise.resolve(this.token.value);
    this.login ??= (async () => {
      try {
        const body = await this.send("POST", "/api/v1/authentication/login", {
          headers: { "x-client-id": this.opts.clientId, "x-api-key": this.opts.apiKey },
        });
        const { token } = this.parse(LoginSchema, body);
        this.token = { value: token, expiresAt: Date.now() + TOKEN_TTL_MS };
        return token;
      } finally {
        this.login = null;
      }
    })();
    return this.login;
  }

  private sleep(ms: number): Promise<void> {
    return (this.opts.sleep ?? Bun.sleep)(ms);
  }

  /**
   * Re-logs in once on 401. GETs retry on 429/5xx/network errors, waiting at least as long as a Retry-After asks.
   * Mutating calls are never retried here: only the gateway, which owns the request_id, may decide what an
   * ambiguous create means.
   */
  private async request(
    method: "GET" | "POST",
    path: string,
    opts: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.ensureToken();
      try {
        return await this.send(method, path, { ...opts, headers: { authorization: `Bearer ${token}` } });
      } catch (error) {
        if (error instanceof AwxHttpError && error.status === 401 && attempt === 0) {
          // Only drop the token this request used; another caller may already have logged in again.
          if (this.token?.value === token) this.token = null;
          continue;
        }
        const retryable =
          error instanceof AwxNetworkError || (error instanceof AwxHttpError && (error.status === 429 || error.status >= 500));
        if (method === "GET" && retryable && attempt < 3) {
          const backoff = 250 * 2 ** attempt + Math.random() * 100;
          const asked = error instanceof AwxHttpError ? (error.retryAfterMs ?? 0) : 0;
          await this.sleep(Math.min(Math.max(backoff, asked), MAX_RETRY_WAIT_MS));
          continue;
        }
        throw error;
      }
    }
  }

  private async send(
    method: "GET" | "POST",
    path: string,
    opts: { query?: Record<string, string>; body?: unknown; headers?: Record<string, string> },
  ): Promise<unknown> {
    await this.pace();
    const url = new URL(path, this.opts.baseUrl);
    for (const [key, value] of Object.entries(opts.query ?? {})) url.searchParams.set(key, value);

    let response: Response;
    let text: string;
    try {
      response = await (this.opts.fetch ?? fetch)(url, {
        method,
        headers: { "content-type": "application/json", ...opts.headers },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
      });
      text = await response.text();
    } catch (cause) {
      throw new AwxNetworkError(`${method} ${path} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }

    let json: unknown;
    try {
      json = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      if (response.ok) throw new AwxNetworkError(`${method} ${path}: unreadable 2xx body`);
      json = { message: text.slice(0, 200) };
    }
    if (response.ok) return json;

    const error = ErrorBodySchema.safeParse(json);
    throw new AwxHttpError(
      response.status,
      (error.success && error.data.code) || "unknown",
      (error.success && error.data.message) || response.statusText,
      json,
      parseRetryAfter(response.headers.get("retry-after"), Date.now()),
    );
  }
}
