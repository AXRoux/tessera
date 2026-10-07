import { z } from "zod";
import {
  AwxHttpError,
  AwxNetworkError,
  BalanceListSchema,
  FinancialTransactionListSchema,
  TransferListSchema,
  TransferSchema,
  type CreateTransferRequest,
  type FinancialTransaction,
  type BalanceApi,
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
}

const LoginSchema = z.object({ token: z.string() });
const ErrorBodySchema = z.looseObject({ code: z.string().optional(), message: z.string().optional() });
const TOKEN_TTL_MS = 25 * 60_000; // tokens last 30 minutes

export class AirwallexClient implements PayoutApi, ReconciliationApi, BalanceApi {
  private token: { value: string; expiresAt: number } | null = null;
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

  async findTransferByRequestId(requestId: string): Promise<Transfer | null> {
    const body = await this.request("GET", "/api/v1/transfers", { query: { request_id: requestId } });
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
          await Bun.sleep(900 * (attempt + 1));
          continue;
        }
        throw error;
      }
    }
  }

  async listBeneficiaries(): Promise<Array<{ id: string; nickname?: string }>> {
    const body = await this.request("GET", "/api/v1/beneficiaries", { query: { page_size: "100" } });
    return z.looseObject({ items: z.array(z.looseObject({ id: z.string(), nickname: z.string().optional() })) }).parse(body).items;
  }

  /** Transfers created since `fromCreatedAt` (ISO 8601). Used to prove no duplicate exists for a reference. */
  async listTransfers(fromCreatedAt: string): Promise<Transfer[]> {
    const body = await this.request("GET", "/api/v1/transfers", { query: { from_created_at: fromCreatedAt, page_size: "200" } });
    return this.parse(TransferListSchema, body).items;
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
    if (wait > 0) await Bun.sleep(wait);
  }

  private async ensureToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    const body = await this.send("POST", "/api/v1/authentication/login", {
      headers: { "x-client-id": this.opts.clientId, "x-api-key": this.opts.apiKey },
    });
    const { token } = this.parse(LoginSchema, body);
    this.token = { value: token, expiresAt: Date.now() + TOKEN_TTL_MS };
    return token;
  }

  /**
   * Re-logs in once on 401. GETs retry on 429/5xx/network errors. Mutating calls are never retried here:
   * only the gateway, which owns the request_id, may decide what an ambiguous create means.
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
          this.token = null;
          continue;
        }
        const retryable =
          error instanceof AwxNetworkError || (error instanceof AwxHttpError && (error.status === 429 || error.status >= 500));
        if (method === "GET" && retryable && attempt < 3) {
          await Bun.sleep(250 * 2 ** attempt + Math.random() * 100);
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
    );
  }
}
