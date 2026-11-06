import { FakePayoutApi } from "../../src/airwallex/fake";
import { newNonce } from "../../src/approval/approval";
import { Closer } from "../../src/closer/closer";
import { Commander } from "../../src/commander/commander";
import { DEFAULT_POLICY, type CommanderPolicy } from "../../src/commander/policy";
import { issueFundingApproval, type FundingApproval, type FundingApprovalPayload } from "../../src/funding/approval";
import { FundingExecutor, type FundingExecutorConfig } from "../../src/funding/executor";
import { PayoutGateway } from "../../src/gateway/gateway";
import { Ledger, type Attempt, type Obligation } from "../../src/ledger/ledger";
import { toMinor } from "../../src/money";
import { approve, SECRET } from "./world";

/** €25.00 over SWIFT (fee €13.33), the reserve floor €1,000.00: the ACME-1047 funding incident. */
export const AMOUNT_MINOR = 2_500;
/** What the EUR wallet holds once the first payment failed and its fee was kept: €1,011.67, €26.66 short. */
export const SHORTFALL_MINOR = 2_666;
/** €26.66 at EURUSD 1.130824, rounded up: $30.15. */
export const SELL_MINOR = 3_015;

export interface FundWorld {
  ledger: Ledger;
  api: FakePayoutApi;
  gateway: PayoutGateway;
  executor: FundingExecutor;
  commander: Commander;
  closer: Closer;
  policy: CommanderPolicy;
  obligation: Obligation;
  dead: Attempt;
  /** Another executor on the same ledger and Airwallex: a second process, or this one after a restart. */
  executorWith(config?: Partial<FundingExecutorConfig>): FundingExecutor;
}

export interface FundWorldOptions {
  amountMinor?: number;
  /** The EUR wallet before the first payment, major units. Default: the floor plus the invoice (as the demo stages it). */
  eurMajor?: number;
  policy?: Partial<CommanderPolicy>;
  api?: FakePayoutApi;
  ledger?: Ledger;
  now?: () => Date;
}

/** A EUR invoice whose first payment failed transiently and was cancelled, from a wallet staged short of the replacement. */
export async function fundWorld(options: FundWorldOptions = {}): Promise<FundWorld> {
  const ledger = options.ledger ?? new Ledger(":memory:");
  const api = options.api ?? new FakePayoutApi();
  const policy: CommanderPolicy = { ...DEFAULT_POLICY, paidHoldMs: 0, ...options.policy };
  const amountMinor = options.amountMinor ?? AMOUNT_MINOR;
  const floor = policy.reserveFloorMinor.EUR ?? 0;
  api.balances.set("EUR", options.eurMajor ?? (floor + amountMinor) / 100);
  const gateway = new PayoutGateway({ ledger, api, approvalSecret: SECRET });
  const executorWith = (config: Partial<FundingExecutorConfig> = {}) =>
    new FundingExecutor({ ledger, api, approvalSecret: SECRET, policy, sleep: async () => {}, ...(options.now ? { now: options.now } : {}), ...config });
  const executor = executorWith();
  const commander = new Commander({ ledger, gateway, balances: api, funding: { fx: api, executor }, secret: SECRET, policy, ...(options.now ? { now: options.now } : {}) });
  const closer = new Closer({ ledger, api, gateway, secret: SECRET, paidHoldMs: 0 });
  const obligation = ledger.createObligation({
    reference: `ACME-1047-${crypto.randomUUID().slice(0, 4)}`, beneficiaryId: "ben-EU", amountMinor, currency: "EUR", method: "SWIFT",
    reason: "professional_business_services",
  });
  const { attempt } = await gateway.submit(approve(obligation));
  api.advance(attempt.transferId!, "SENT");
  api.advance(attempt.transferId!, "FAILED", "91402");
  api.advance(attempt.transferId!, "CANCELLED", "91402");
  const [dead] = await gateway.sync(obligation.id);
  return { ledger, api, gateway, executor, commander, closer, policy, obligation, dead: dead!, executorWith };
}

/**
 * A funding approval signed by code for a fresh quote, as the Commander would issue it, with any field overridden. Tests
 * use it to reach the executor's own checks directly, as a caller that skipped the Commander would.
 */
export async function fundingApproval(
  w: FundWorld,
  overrides: Partial<FundingApprovalPayload> & { buyMinor?: number; sellCurrency?: string } = {},
): Promise<FundingApproval> {
  const buyMinor = overrides.buyMinor ?? SHORTFALL_MINOR;
  const sellCurrency = overrides.sellCurrency ?? "USD";
  const quote = await w.api.createQuote({ buy_currency: "EUR", sell_currency: sellCurrency, buy_amount: buyMinor / 100, validity: "MIN_1" });
  return issueFundingApproval(
    {
      kind: "FUNDING", obligationId: w.obligation.id, forAttemptId: w.dead.id, quoteId: quote.quote_id, currencyPair: quote.currency_pair,
      buyCurrency: "EUR", buyMinor, sellCurrency, sellMinor: toMinor(quote.sell_amount, sellCurrency), rate: quote.client_rate,
      quoteValidTo: quote.valid_to_at, evidenceHash: "b".repeat(64), mode: "POLICY", approver: "policy:commander",
      expiresAt: new Date(Date.now() + 60_000).toISOString(), nonce: newNonce(), ...overrides,
    },
    SECRET,
  );
}
