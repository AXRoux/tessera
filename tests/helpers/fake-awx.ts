import {
  AwxHttpError,
  AwxNetworkError,
  type CreateTransferRequest,
  type FinancialTransaction,
  type BalanceApi,
  type PayoutApi,
  type ReconciliationApi,
  type Transfer,
} from "../../src/airwallex/types";

/**
 * In-memory Airwallex with the behaviors the gateway and Closer depend on, verified against the real sandbox:
 * request_id dedupe (400 duplicate_request_id carrying the existing id), lookup by request_id, 404 on unknown ids,
 * fees read from the response, and wallet lines per transfer (PAYOUT and FEE on create, PAYOUT_REVERSAL on CANCELLED).
 * Faults count down per call.
 */
export class FakePayoutApi implements PayoutApi, ReconciliationApi, BalanceApi {
  readonly transfers = new Map<string, Transfer>();
  /** Wallet lines by transfer id. Tests may edit these to simulate a booking Airwallex got wrong. */
  readonly wallet = new Map<string, FinancialTransaction[]>();
  /** Available balance per currency in major units. Unlisted currencies are well funded. */
  readonly balances = new Map<string, number>();
  private readonly byRequest = new Map<string, string>();
  createCalls = 0;
  faults = { failBeforeCreate: 0, loseResponseAfterCreate: 0, rejectCreate: 0, failLookup: 0 };

  get all(): Transfer[] {
    return [...this.transfers.values()];
  }

  async createTransfer(request: CreateTransferRequest): Promise<Transfer> {
    this.createCalls++;
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

  async findTransferByRequestId(requestId: string): Promise<Transfer | null> {
    if (this.faults.failLookup > 0) {
      this.faults.failLookup--;
      throw new AwxNetworkError("lookup timed out");
    }
    const id = this.byRequest.get(requestId);
    return id ? structuredClone(this.transfers.get(id)!) : null;
  }

  /** Test control: move a transfer the way the sandbox simulator does. */
  advance(transferId: string, status: string, failureCode?: string): void {
    const transfer = this.transfers.get(transferId);
    if (!transfer) throw new Error(`unknown transfer ${transferId}`);
    transfer.status = status;
    if (failureCode) transfer.failure = { code: failureCode, message: "simulated failure" };
    if (status === "CANCELLED") this.book(transfer, "PAYOUT_REVERSAL", transfer.transfer_amount);
  }

  async listFinancialTransactions(sourceId: string): Promise<FinancialTransaction[]> {
    return structuredClone(this.wallet.get(sourceId) ?? []);
  }

  async listTransfers(_fromCreatedAt: string): Promise<Transfer[]> {
    return structuredClone(this.all);
  }

  async getAvailableBalance(currency: string): Promise<number> {
    return this.balances.get(currency) ?? 1_000_000;
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
}
