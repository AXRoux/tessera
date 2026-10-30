import failureCodes from "../../fixtures/failure-codes.json";
import {
  AwxHttpError,
  AwxNetworkError,
  type BalanceApi,
  type Beneficiary,
  type BeneficiaryApi,
  type CreateTransferRequest,
  type FinancialTransaction,
  type NewEuBeneficiary,
  type NewUsBeneficiary,
  type PayoutApi,
  type ReconciliationApi,
  type Transfer,
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

/**
 * In-memory Airwallex with the behaviors the gateway and Closer depend on, verified against the real sandbox:
 * request_id dedupe (400 duplicate_request_id carrying the existing id), lookup by request_id, 404 on unknown ids,
 * fees read from the response, wallet lines per transfer (PAYOUT and FEE on create, PAYOUT_REVERSAL on CANCELLED),
 * `created_at`/`updated_at` on every snapshot, and cursor-paged transfer listing. `advance` plays the sandbox
 * simulator, so the offline demo runs on this too. Faults count down per call.
 */
export class FakePayoutApi implements PayoutApi, ReconciliationApi, BalanceApi, BeneficiaryApi {
  readonly transfers = new Map<string, Transfer>();
  /** Wallet lines by transfer id. Tests may edit these to simulate a booking Airwallex got wrong. */
  readonly wallet = new Map<string, FinancialTransaction[]>();
  /** Available balance per currency in major units. Unlisted currencies are well funded. */
  readonly balances = new Map<string, number>();
  readonly beneficiaries: Beneficiary[];
  private readonly byRequest = new Map<string, string>();
  private readonly now: () => Date;
  private readonly pageSize: number;
  private readonly secondResolution: boolean;
  private lastStamp = 0;
  createCalls = 0;
  faults = { failBeforeCreate: 0, loseResponseAfterCreate: 0, rejectCreate: 0, failLookup: 0, rateLimitCreate: 0 };
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

    const fee = request.transfer_method === "SWIFT" ? 13.33 : 3;
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
    transfer.status = status;
    transfer.updated_at = this.stamp();
    if (failureType) {
      const known = FAILURES.get(failureType);
      transfer.failure = { code: known?.code ?? failureType, message: known?.message ?? "simulated failure" };
    }
    if (status === "CANCELLED") this.book(transfer, "PAYOUT_REVERSAL", transfer.transfer_amount);
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

  async getAvailableBalance(currency: string): Promise<number> {
    return this.balances.get(currency) ?? 1_000_000;
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
    const lines = this.wallet.get(transfer.id) ?? [];
    lines.push({
      id: crypto.randomUUID(),
      source_id: transfer.id,
      source_type: type === "FEE" ? "FEE" : "PAYOUT",
      transaction_type: type,
      currency: transfer.transfer_currency,
      amount: net,
      net,
      fee: 0,
      status,
    });
    this.wallet.set(transfer.id, lines);
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
