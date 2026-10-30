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

export const BalanceListSchema = z.array(z.looseObject({ currency: z.string(), available_amount: z.number() }));

/** Spendable wallet balance in major units. The Commander checks it before proposing a replacement. */
export interface BalanceApi {
  getAvailableBalance(currency: string): Promise<number>;
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
