import { z } from "zod";
import {
  AwxHttpError,
  AwxNetworkError,
  BalanceListSchema,
  FinancialTransactionListSchema,
  TransferListSchema,
  TransferSchema,
  type Beneficiary,
  type BeneficiaryApi,
  type CreateTransferRequest,
  type FinancialTransaction,
  type BalanceApi,
  type NewEuBeneficiary,
  type NewUsBeneficiary,
  type PayoutApi,
  type ReconciliationApi,
  type Transfer,
} from "./types";

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

export class AirwallexClient implements PayoutApi, ReconciliationApi, BalanceApi, BeneficiaryApi {
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

  /** Available wallet balance for one currency, in major units. */
  async getAvailableBalance(currency: string): Promise<number> {
    const balances = this.parse(BalanceListSchema, await this.request("GET", "/api/v1/balances/current"));
    return balances.find((b) => b.currency === currency)?.available_amount ?? 0;
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
