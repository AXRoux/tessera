import { issueApproval, newNonce, requireHumanNote, type Approval } from "../approval/approval";
import { sellPerBuy, type BalanceApi, type FxApi, type FxQuote } from "../airwallex/types";
import { canonicalJson, sha256Hex } from "../canonical";
import { ApprovalRejected, AutoReplacementRefused, FundingRefused, NotClosable } from "../errors";
import { issueFundingApproval, type FundingApproval } from "../funding/approval";
import { QUOTE_SEND_MARGIN_MS, type FundingExecutor, type FundingResult } from "../funding/executor";
import type { PayoutGateway, SubmitResult } from "../gateway/gateway";
import type { ConversionAttempt } from "../ledger/conversions";
import { paidObservedAt, TransferStatusPayloadSchema } from "../ledger/events";
import type { Attempt, Ledger, LedgerEvent, Method, Obligation } from "../ledger/ledger";
import { formatMinor, fromMinor, toMinor } from "../money";
import { z } from "zod";
import type { SupplierEvidence } from "./evidence";
import { DEFAULT_POLICY, decide, type CommanderPolicy, type Decision, type FundingPlan, type IncidentFacts } from "./policy";

export interface CommanderConfig {
  ledger: Ledger;
  gateway: PayoutGateway;
  balances: BalanceApi;
  /**
   * Airwallex FX and the executor that books conversions. Without them no plan can be priced, so FUND is never allowed
   * and a short wallet is escalated, as it was before funding existed.
   */
  funding?: { fx: FxApi; executor: FundingExecutor };
  /** Signs approvals. Held by this process only; the model never receives it. */
  secret: string;
  policy?: CommanderPolicy;
  now?: () => Date;
}

export interface Assessment {
  obligationId: string;
  facts: IncidentFacts;
  decision: Decision;
  /** Binds any approval issued from this assessment to the exact evidence and decision the approver saw. */
  evidenceHash: string;
}

/** The ledger's view of one incident, to decide on without asking Airwallex anything (before/after comparisons). */
export interface LedgerSnapshot {
  obligation: Obligation;
  attempts: Attempt[];
  events: LedgerEvent[];
  /** Read from the ledger when absent. */
  conversions?: ConversionAttempt[];
}

/** Terms a human may change when replacing a failed attempt. Amount and currency can never change. */
export interface HumanApprovalInput {
  obligationId: string;
  /** Authenticated identity of the approver; authentication happens in the caller. */
  approver: string;
  note: string;
  /** The `evidenceHash` of the assessment the approver was shown. A different current hash means they approved stale facts. */
  evidenceHash: string;
  evidence?: SupplierEvidence | null;
  beneficiaryId?: string;
  method?: Method;
  reason?: string;
}

/** A quote as Tessera binds approvals to it: amounts in minor units, times in ISO 8601 UTC. */
export interface QuoteTerms {
  quoteId: string;
  currencyPair: string;
  buyCurrency: string;
  buyMinor: number;
  sellCurrency: string;
  sellMinor: number;
  rate: number;
  validFrom: string;
  validTo: string;
}

/** A quote fetched for a person to review (step one of two), with the fingerprint their approval must echo back. */
export interface FundingQuoteForReview extends QuoteTerms {
  obligationId: string;
  forAttemptId: string;
  evidenceHash: string;
  fingerprint: string;
  plan: FundingPlan;
}

/** A person approving a reviewed quote (step two). The quote is the one Tessera recorded, never one the caller supplies. */
export interface FundingApprovalInput {
  obligationId: string;
  approver: string;
  note: string;
  evidenceHash: string;
  quoteId: string;
  fingerprint: string;
  evidence?: SupplierEvidence | null;
}

export interface AutoFundingResult {
  plan: FundingPlan;
  quote: QuoteTerms;
  result: FundingResult;
  /** Why earlier quotes were not booked (rate drift, expiry), in the order they were thrown away. */
  replans: string[];
}

const APPROVAL_TTL_MS = 5 * 60_000;
/** Fresh plans (each with a fresh quote) the automatic path tries before it gives the incident to a person. */
const MAX_FUNDING_PLANS = 3;

const FundingQuotedSchema = z.looseObject({
  forAttemptId: z.string(),
  evidenceHash: z.string(),
  fingerprint: z.string(),
  quote: z.object({
    quoteId: z.string(), currencyPair: z.string(), buyCurrency: z.string(), buyMinor: z.number(), sellCurrency: z.string(),
    sellMinor: z.number(), rate: z.number(), validFrom: z.string(), validTo: z.string(),
  }),
});

/** When the ledger last saw `attemptId` become FAILED, or null if it never did. */
function failedObservedAt(events: LedgerEvent[], attemptId: string): string | null {
  let at: string | null = null;
  for (const event of events) {
    if (event.type !== "TRANSFER_STATUS") continue;
    const payload = TransferStatusPayloadSchema.safeParse(event.payload);
    if (payload.success && payload.data.attemptId === attemptId && payload.data.to === "FAILED" && payload.data.from !== "FAILED") at = event.ts;
  }
  return at;
}

/** Replacements made under a code-granted (POLICY) approval. The first payment is not a replacement. */
function automaticReplacements(events: LedgerEvent[]): number {
  return events.filter((e) => {
    if (e.type !== "ATTEMPT_INTENT") return false;
    const p = e.payload as { mode?: unknown; replaces?: unknown } | null;
    return p?.mode === "POLICY" && p.replaces != null;
  }).length;
}

export const quoteTerms = (quote: FxQuote): QuoteTerms => ({
  quoteId: quote.quote_id,
  currencyPair: quote.currency_pair,
  buyCurrency: quote.buy_currency,
  buyMinor: toMinor(quote.buy_amount, quote.buy_currency),
  sellCurrency: quote.sell_currency,
  sellMinor: toMinor(quote.sell_amount, quote.sell_currency),
  rate: quote.client_rate,
  validFrom: quote.valid_from_at,
  validTo: quote.valid_to_at,
});

/** What a person's funding approval is bound to: the incident, the replacement, the quote and the assessment they saw. */
export const fundingFingerprint = (obligationId: string, forAttemptId: string, quote: QuoteTerms, evidenceHash: string): string =>
  sha256Hex(canonicalJson({ obligationId, forAttemptId, quote, evidenceHash }));

export class Commander {
  private readonly ledger: Ledger;
  private readonly gateway: PayoutGateway;
  private readonly balances: BalanceApi;
  private readonly funding: { fx: FxApi; executor: FundingExecutor } | null;
  private readonly secret: string;
  /** The thresholds this Commander decides with. Read-only: callers (the demo, the console) show them, never change them. */
  readonly policy: CommanderPolicy;
  private readonly now: () => Date;

  constructor(config: CommanderConfig) {
    this.ledger = config.ledger;
    this.gateway = config.gateway;
    this.balances = config.balances;
    this.funding = config.funding ?? null;
    this.secret = config.secret;
    this.policy = config.policy ?? DEFAULT_POLICY;
    this.now = config.now ?? (() => new Date());
  }

  /**
   * Refreshes from Airwallex, then decides. Moves no money. Indicative FX rates are read only when the decision needs
   * funding, and the decision is then made again with them, so a plan always carries a priced source or says why not.
   */
  async assess(obligationId: string, evidence: SupplierEvidence | null = null): Promise<Assessment> {
    await this.gateway.sync(obligationId);
    // A booked conversion may have settled since the last look; this adopts what Airwallex says and sends nothing.
    await this.funding?.executor.sync(obligationId);
    const snapshot = this.snapshot(obligationId);
    const wallets = await this.readWallets();
    let facts = this.factsFrom(snapshot, evidence, wallets, {});
    let decision = decide(facts, this.policy);
    if (decision.funding !== null) {
      facts = { ...facts, fxRates: await this.ratesFor(decision.funding.currency, decision.funding.buyMinor) };
      decision = decide(facts, this.policy);
    }
    return { obligationId, facts, decision, evidenceHash: this.hashOf(snapshot, evidence, decision) };
  }

  /**
   * Decides on a ledger snapshot with wallets the caller already read (`readWallets`), without syncing anything: the same
   * facts `assess` builds, for comparing a decision before and after a change. Rates default to none, so a replacement
   * that needs funding is decided as unpriced (escalate) unless the caller passes them.
   */
  decideOn(snapshot: LedgerSnapshot, evidence: SupplierEvidence | null, wallets: Record<string, number> | null, fxRates: Record<string, number | null> = {}): Decision {
    return decide(this.factsFrom(snapshot, evidence, wallets, fxRates), this.policy);
  }

  /** Every wallet's available balance in minor units, or null when Airwallex could not be read (decisions then fail closed). */
  async readWallets(): Promise<Record<string, number> | null> {
    try {
      const rows = await this.balances.getBalances();
      return Object.fromEntries(rows.map((b) => [b.currency, toMinor(b.available_amount, b.currency)]));
    } catch {
      return null;
    }
  }

  private snapshot(obligationId: string): LedgerSnapshot {
    return {
      obligation: this.ledger.requireObligation(obligationId),
      attempts: this.ledger.attemptsFor(obligationId),
      events: this.ledger.events(obligationId),
    };
  }

  private factsFrom(snapshot: LedgerSnapshot, evidence: SupplierEvidence | null, wallets: Record<string, number> | null, fxRates: Record<string, number | null>): IncidentFacts {
    const { obligation, attempts, events } = snapshot;
    const latest = attempts.at(-1);
    const conversion = latest
      ? (snapshot.conversions ?? this.ledger.conversionsFor(obligation.id)).findLast((c) => c.forAttemptId === latest.id && c.state !== "ABANDONED" && c.state !== "CANCELLED")
      : undefined;
    return {
      obligation,
      attempts,
      paidObservedAt: latest?.state === "PAID" ? paidObservedAt(events, latest.id) : null,
      failedObservedAt: latest?.awxStatus === "FAILED" ? failedObservedAt(events, latest.id) : null,
      automaticReplacements: automaticReplacements(events),
      wallets,
      fxRates,
      funding: conversion
        ? {
            forAttemptId: conversion.forAttemptId, state: conversion.state, conversionId: conversion.conversionId,
            buyCurrency: conversion.buyCurrency, buyMinor: conversion.buyMinor, sellCurrency: conversion.sellCurrency, sellMinor: conversion.sellMinor,
          }
        : null,
      evidence,
      now: this.now(),
    };
  }

  /** Indicative units of each permitted source currency one unit of `currency` costs; null where no rate could be read. */
  /** Indicative rates from every funding source into `currency`, for a buy of `buyMinor`; an unreadable one is null. */
  async ratesFor(currency: string, buyMinor: number): Promise<Record<string, number | null>> {
    const rates: Record<string, number | null> = {};
    for (const source of this.policy.fundingSources) {
      if (source === currency) continue;
      rates[source] = null;
      if (!this.funding) continue;
      try {
        const rate = await this.funding.fx.getRate(currency, source, fromMinor(buyMinor, currency));
        rates[source] = sellPerBuy(rate.currency_pair, currency, source, rate.rate);
      } catch {
        // An unreadable rate leaves this source unpriced, so the plan cannot use it.
      }
    }
    return rates;
  }

  /**
   * What an approval from this assessment is bound to. Everything in it is a fact or a decision, never prose: the reasons
   * say things like "Processing for 3h" and would make an approval go stale on the hour. A funding plan is bound by what
   * it buys and from where, not by its indicative price (the quote binds the price).
   */
  private hashOf(snapshot: LedgerSnapshot, evidence: SupplierEvidence | null, decision: Decision): string {
    const { obligation, attempts } = snapshot;
    const previous = attempts.at(-1) ?? null;
    const funding = decision.funding;
    return sha256Hex(
      canonicalJson({
        obligation: { id: obligation.id, amountMinor: obligation.amountMinor, currency: obligation.currency, status: obligation.status },
        // The terms an approval proposes unless the approver overrides them: the latest attempt's, else the obligation's.
        proposed: {
          beneficiaryId: previous?.beneficiaryId ?? obligation.beneficiaryId,
          method: previous?.method ?? obligation.method,
          reason: previous?.reason ?? obligation.reason,
        },
        evidence,
        decision: {
          recommended: decision.recommended,
          allowed: decision.allowed,
          blocked: decision.blocked.map((b) => b.action),
          autoApprovable: decision.replacement?.autoApprovable ?? null,
          funding: funding
            ? { forAttemptId: funding.forAttemptId, feasible: funding.feasible, buyMinor: funding.buyMinor, sellCurrency: funding.sellCurrency, autoApprovable: funding.autoApprovable }
            : null,
        },
        attempts: attempts.map((a) => ({ id: a.id, state: a.state, failureCode: a.failureCode })),
        conversions: this.ledger.conversionsFor(obligation.id).map((c) => ({ id: c.id, state: c.state })),
      }),
    );
  }

  /**
   * The Closer proves the books tie; it cannot know a supplier is disputing receipt, or that a person already has the
   * incident. The Commander can. Certifying needs both, so every caller (the agent's close tool and the operator's close
   * route) goes through this before asking the Closer. An incident that is already certified just returns its certificate.
   */
  async assertCloseAllowed(obligationId: string, evidence: SupplierEvidence | null = null): Promise<void> {
    if (this.ledger.requireObligation(obligationId).status === "CLOSED") return;
    const { decision } = await this.assess(obligationId, evidence);
    if (decision.allowed.includes("CLOSE")) return;
    throw new NotClosable(obligationId, [
      `the assessment does not allow closing (allowed: ${decision.allowed.join(", ") || "nothing"})`,
      ...decision.reasons,
    ]);
  }

  /**
   * Replaces a failed attempt under a policy-signed approval, only when the policy says it is safe to do
   * automatically: transient failure, funds returned, wallet covers it, amount within the automatic limit.
   */
  async replaceAutomatically(obligationId: string, evidence: SupplierEvidence | null = null): Promise<SubmitResult> {
    const assessment = await this.assess(obligationId, evidence);
    const { decision } = assessment;
    if (decision.recommended !== "REPLACE" || !decision.allowed.includes("REPLACE") || !decision.replacement?.autoApprovable) {
      throw new AutoReplacementRefused(obligationId, decision);
    }
    const previous = assessment.facts.attempts.at(-1)!;
    const approval = issueApproval(
      {
        obligationId,
        amountMinor: previous.amountMinor,
        currency: previous.currency,
        beneficiaryId: previous.beneficiaryId,
        method: previous.method,
        reason: previous.reason,
        replacesAttemptId: previous.id,
        evidenceHash: assessment.evidenceHash,
        mode: "POLICY",
        approver: "policy:commander",
        expiresAt: new Date(this.now().getTime() + APPROVAL_TTL_MS).toISOString(),
        nonce: newNonce(),
      },
      this.secret,
    );
    return this.gateway.submit(approval);
  }

  /**
   * Builds the approval a named human has authorized. The gateway still applies the playbook: a note unlocks
   * AFTER_CHANGE and FORBIDDEN replacements but cannot change the amount or skip the lock.
   */
  async humanApproval(input: HumanApprovalInput): Promise<Approval> {
    const assessment = await this.assess(input.obligationId, input.evidence ?? null);
    if (assessment.evidenceHash !== input.evidenceHash) {
      throw new ApprovalRejected("stale_evidence", "the incident changed since the approver reviewed it; review the current assessment and approve again");
    }
    const previous = assessment.facts.attempts.at(-1) ?? null;
    const obligation = this.ledger.requireObligation(input.obligationId);
    return issueApproval(
      {
        obligationId: obligation.id,
        amountMinor: obligation.amountMinor,
        currency: obligation.currency,
        beneficiaryId: input.beneficiaryId ?? previous?.beneficiaryId ?? obligation.beneficiaryId,
        method: input.method ?? previous?.method ?? obligation.method,
        reason: input.reason ?? previous?.reason ?? obligation.reason,
        replacesAttemptId: previous?.id ?? null,
        evidenceHash: assessment.evidenceHash,
        mode: "HUMAN",
        approver: input.approver,
        note: input.note,
        expiresAt: new Date(this.now().getTime() + APPROVAL_TTL_MS).toISOString(),
        nonce: newNonce(),
      },
      this.secret,
    );
  }

  // ---- funding a replacement from another wallet ---------------------------------------------------------------------

  /**
   * Converts from another wallet so a replacement can be paid, when the assessment allows FUND and the plan is within the
   * automatic conversion limit. The caller supplies only the incident: the source, both amounts and the rate come from the
   * plan and a fresh quote. A quote that drifts from the plan, is too old or expires is never booked: the incident is
   * re-planned on fresh balances and rates, at most three times, and then given to a person.
   */
  async fundAutomatically(obligationId: string, evidence: SupplierEvidence | null = null): Promise<AutoFundingResult> {
    const funding = this.requireFunding(obligationId);
    const replans: string[] = [];
    for (let round = 0; round < MAX_FUNDING_PLANS; round++) {
      const assessment = await this.assess(obligationId, evidence);
      const plan = this.allowedPlan(obligationId, assessment);
      if (!plan.autoApprovable) throw new FundingRefused(obligationId, ["This conversion needs a person's approval, so nothing was converted.", plan.summary], plan);
      const quote = quoteTerms(
        await funding.fx.createQuote({ buy_currency: plan.currency, sell_currency: plan.sellCurrency!, buy_amount: fromMinor(plan.buyMinor, plan.currency), validity: "MIN_1" }),
      );
      const problem = this.quoteProblem(plan, quote);
      if (problem) {
        this.replanned(obligationId, quote, problem, replans);
        continue;
      }
      const approval = this.fundingApproval(obligationId, plan.forAttemptId, quote, assessment.evidenceHash, { mode: "POLICY", approver: "policy:commander" });
      try {
        const result = await funding.executor.book(approval);
        if (result.outcome === "REJECTED" && result.conversion.lastError?.startsWith("expired_quote")) {
          this.replanned(obligationId, quote, "Airwallex answered that the quote had expired", replans);
          continue;
        }
        return { plan, quote, result, replans };
      } catch (error) {
        if (!(error instanceof FundingRefused) || !error.replan) throw error;
        this.replanned(obligationId, quote, error.reasons.join(" "), replans);
      }
    }
    throw new FundingRefused(obligationId, [
      `Nothing was converted: ${MAX_FUNDING_PLANS} fresh quotes in a row did not match the plan (${replans.join("; ")}). A person should look.`,
    ]);
  }

  /**
   * Step one of a person's approval: a quote for the current plan (valid 15 minutes, booked only while younger than the
   * policy's maximum quote age), recorded in the ledger with the fingerprint the approval must echo back.
   */
  async quoteForReview(obligationId: string, evidence: SupplierEvidence | null = null): Promise<FundingQuoteForReview> {
    const funding = this.requireFunding(obligationId);
    const assessment = await this.assess(obligationId, evidence);
    const plan = this.allowedPlan(obligationId, assessment);
    const quote = quoteTerms(
      await funding.fx.createQuote({ buy_currency: plan.currency, sell_currency: plan.sellCurrency!, buy_amount: fromMinor(plan.buyMinor, plan.currency), validity: "MIN_15" }),
    );
    const problem = this.quoteProblem(plan, quote);
    if (problem) throw new FundingRefused(obligationId, [`The quote Airwallex gave does not match the plan (${problem}). Fetch another.`], plan, true);
    const fingerprint = fundingFingerprint(obligationId, plan.forAttemptId, quote, assessment.evidenceHash);
    this.ledger.append(obligationId, "FUNDING_QUOTED", { forAttemptId: plan.forAttemptId, evidenceHash: assessment.evidenceHash, fingerprint, quote, plan: plan.summary });
    return { ...quote, obligationId, forAttemptId: plan.forAttemptId, evidenceHash: assessment.evidenceHash, fingerprint, plan };
  }

  /**
   * Step two: the approval a named person gives to the quote they reviewed. It is refused if the incident changed, if the
   * quote is not the one Tessera recorded last or differs in any bound field, or if it is too old to book.
   */
  async humanFundingApproval(input: FundingApprovalInput): Promise<FundingApproval> {
    requireHumanNote(input.approver, input.note);
    const assessment = await this.assess(input.obligationId, input.evidence ?? null);
    if (assessment.evidenceHash !== input.evidenceHash) {
      throw new ApprovalRejected("stale_evidence", "the incident changed since the approver reviewed it; review the current assessment and approve again");
    }
    const plan = this.allowedPlan(input.obligationId, assessment);
    const quoted = this.ledger
      .events(input.obligationId)
      .flatMap((e) => (e.type === "FUNDING_QUOTED" ? [FundingQuotedSchema.safeParse(e.payload).data].filter((q) => q !== undefined) : []))
      .at(-1);
    if (!quoted || quoted.quote.quoteId !== input.quoteId) {
      throw new ApprovalRejected("stale", "that is not the latest quote Tessera fetched for this incident; fetch a fresh one and review it");
    }
    const recomputed = fundingFingerprint(input.obligationId, quoted.forAttemptId, quoted.quote, quoted.evidenceHash);
    if (recomputed !== quoted.fingerprint || input.fingerprint !== quoted.fingerprint) {
      throw new ApprovalRejected("stale", "the quote differs from the one you reviewed; review it again");
    }
    if (quoted.evidenceHash !== assessment.evidenceHash || quoted.forAttemptId !== plan.forAttemptId) {
      throw new ApprovalRejected("stale_evidence", "the incident changed since this quote was fetched; fetch a fresh one");
    }
    const problem = this.quoteProblem(plan, quoted.quote);
    if (problem) throw new FundingRefused(input.obligationId, [`This quote can no longer be booked (${problem}). Fetch a fresh one.`], plan, true);
    return this.fundingApproval(input.obligationId, plan.forAttemptId, quoted.quote, assessment.evidenceHash, { mode: "HUMAN", approver: input.approver, note: input.note });
  }

  /** A person's approval, booked at once (the approval is single-use and expires in five minutes either way). */
  async approveFunding(input: FundingApprovalInput): Promise<FundingResult> {
    const approval = await this.humanFundingApproval(input);
    return this.requireFunding(input.obligationId).executor.book(approval);
  }

  /** Resolves conversions left in INTENT and syncs booked ones (one incident, or all). */
  async recoverFunding(obligationId?: string): Promise<void> {
    await this.funding?.executor.refresh(obligationId);
  }

  private requireFunding(obligationId: string): { fx: FxApi; executor: FundingExecutor } {
    if (!this.funding) throw new FundingRefused(obligationId, ["This server has no Airwallex FX access configured, so it cannot convert currency."]);
    return this.funding;
  }

  /** The plan, if the assessment allows FUND and the plan is feasible; otherwise a refusal carrying every reason. */
  private allowedPlan(obligationId: string, assessment: Assessment): FundingPlan {
    const { decision } = assessment;
    const plan = decision.funding;
    if (decision.allowed.includes("FUND") && plan?.feasible) return plan;
    const blocked = decision.blocked.filter((b) => b.action === "FUND").map((b) => b.reason);
    throw new FundingRefused(
      obligationId,
      [...(blocked.length > 0 ? blocked : [`FUND is not among the allowed actions (${decision.allowed.join(", ") || "nothing"}).`]), ...decision.reasons],
      plan,
    );
  }

  /** Why a quote may not be booked against a plan, or null. Every check is the policy's, in code. */
  private quoteProblem(plan: FundingPlan, quote: QuoteTerms): string | null {
    const now = this.now().getTime();
    const money = formatMinor;
    if (quote.buyCurrency !== plan.currency || quote.sellCurrency !== plan.sellCurrency) {
      return `the quote sells ${quote.sellCurrency} for ${quote.buyCurrency}, the plan sells ${plan.sellCurrency} for ${plan.currency}`;
    }
    if (quote.buyMinor !== plan.buyMinor) return `the quote buys ${money(quote.buyMinor, quote.buyCurrency)} but the plan needs ${money(plan.buyMinor, plan.currency)}`;
    if (now - Date.parse(quote.validFrom) > this.policy.maxQuoteAgeMs) return `the quote is older than ${Math.round(this.policy.maxQuoteAgeMs / 60_000)} minutes`;
    if (Date.parse(quote.validTo) - now < QUOTE_SEND_MARGIN_MS) return `the quote expired at ${quote.validTo}`;
    const ceiling = Math.floor(plan.sellMinor! * (1 + this.policy.maxRateDriftBps / 10_000));
    if (quote.sellMinor > ceiling) {
      return `the rate moved: the quote sells ${money(quote.sellMinor, quote.sellCurrency)} where the plan expected about ${money(plan.sellMinor!, plan.sellCurrency!)} (more than ${this.policy.maxRateDriftBps} basis points)`;
    }
    const source = plan.sources.find((s) => s.currency === quote.sellCurrency);
    if (!source || source.availableMinor - quote.sellMinor < source.floorMinor) {
      return `selling ${money(quote.sellMinor, quote.sellCurrency)} would take the ${quote.sellCurrency} wallet below its reserve`;
    }
    return null;
  }

  private replanned(obligationId: string, quote: QuoteTerms, reason: string, replans: string[]): void {
    replans.push(reason);
    this.ledger.append(obligationId, "FUNDING_REPLANNED", { quoteId: quote.quoteId, reason });
  }

  private fundingApproval(
    obligationId: string,
    forAttemptId: string,
    quote: QuoteTerms,
    evidenceHash: string,
    who: { mode: "POLICY" | "HUMAN"; approver: string; note?: string },
  ): FundingApproval {
    return issueFundingApproval(
      {
        kind: "FUNDING", obligationId, forAttemptId, quoteId: quote.quoteId, currencyPair: quote.currencyPair,
        buyCurrency: quote.buyCurrency, buyMinor: quote.buyMinor, sellCurrency: quote.sellCurrency, sellMinor: quote.sellMinor,
        rate: quote.rate, quoteValidTo: quote.validTo, evidenceHash, ...who,
        expiresAt: new Date(this.now().getTime() + APPROVAL_TTL_MS).toISOString(), nonce: newNonce(),
      },
      this.secret,
    );
  }
}
