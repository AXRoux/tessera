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

export const TransferListSchema = z.looseObject({ items: z.array(TransferSchema) });

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
  constructor(readonly status: number, readonly code: string, message: string, readonly body: unknown) {
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
  findTransferByRequestId(requestId: string): Promise<Transfer | null>;
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
