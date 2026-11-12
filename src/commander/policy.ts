import { lookupFailure, type FailureClass, type ReplacePolicy } from "../domain/playbook";
import type { ConversionState } from "../ledger/conversions";
import type { Attempt, Method, Obligation } from "../ledger/ledger";
import { currencyExponent, formatMinor, fromMinor } from "../money";
import type { ActionKind, Severity } from "./actions";
import type { SupplierEvidence } from "./evidence";

/** Thresholds live here, in code. The model never sees or sets them. */
export interface CommanderPolicy {
  /** How long a transfer may be processing before silence stops being normal, per rail (milliseconds). */
  settlementSlaMs: Record<Method, number>;
  /** Largest replacement the Commander may approve on its own, per currency (minor units). Absent = never automatic. */
  autoReplaceLimitMinor: Record<string, number>;
  /** PAID is not final; how long it must stay PAID before the incident may close. */
  paidHoldMs: number;
  /** Most replacements the Commander may approve on its own for one invoice; beyond this a person decides. */
  maxAutoReplacements: number;
  /** How long a transfer may sit FAILED (awaiting cancellation) before a person is asked to look. */
  failedSlaMs: number;
  /**
   * Cash each wallet keeps, per currency (minor units). An automatic replacement must leave its wallet at or above it,
   * and a conversion may not take the wallet it sells from below it. Absent = 0.
   */
  reserveFloorMinor: Record<string, number>;
  /** Wallets the Commander may sell to fund a replacement, most preferred first. Anything else is never sold. */
  fundingSources: readonly string[];
  /** Largest conversion the Commander may book on its own, per currency bought (minor units). Absent = always a person. */
  autoConvertLimitMinor: Record<string, number>;
  /** Smallest conversion worth booking, per currency bought (minor units); Airwallex refuses below about USD 1. Default 100. */
  minConversionMinor: Record<string, number>;
  /** A quote is booked only while younger than this (and before Airwallex's own expiry); otherwise Tessera re-plans. */
  maxQuoteAgeMs: number;
  /** How far (basis points) a quote's sell amount may exceed the plan's before Tessera re-plans instead of booking it. */
  maxRateDriftBps: number;
}

export const DEFAULT_POLICY: CommanderPolicy = {
  settlementSlaMs: { LOCAL: 48 * 3600_000, SWIFT: 120 * 3600_000 },
  autoReplaceLimitMinor: { USD: 500_000, EUR: 500_000, GBP: 500_000 },
  paidHoldMs: 24 * 3600_000,
  maxAutoReplacements: 2,
  failedSlaMs: 30 * 60_000,
  reserveFloorMinor: { USD: 100_000, EUR: 100_000, GBP: 100_000 },
  fundingSources: ["USD", "GBP", "EUR"],
  autoConvertLimitMinor: { USD: 25_000, EUR: 25_000, GBP: 25_000 },
  minConversionMinor: { USD: 100, EUR: 100, GBP: 100 },
  maxQuoteAgeMs: 5 * 60_000,
  maxRateDriftBps: 50,
};

/**
 * The same policy at a pace a live audience can watch: a transfer is overdue after minutes rather than days, a FAILED
 * transfer is chased after two minutes, and PAID is final after thirty seconds. Only ever applied to the Airwallex
 * sandbox or the offline demo (see TESSERA_PACE in the runtime); real money keeps the banking windows above.
 */
export const LIVE_PACE: Pick<CommanderPolicy, "settlementSlaMs" | "failedSlaMs" | "paidHoldMs"> = {
  settlementSlaMs: { LOCAL: 5 * 60_000, SWIFT: 10 * 60_000 },
  failedSlaMs: 2 * 60_000,
  paidHoldMs: 30_000,
};

/** A length of time as a sentence says it: "40 seconds", "5 minutes", "877 hours". */
export function span(ms: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 120) return unit(seconds, "second");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 120) return unit(minutes, "minute");
  return unit(Math.floor(minutes / 60), "hour");
}

/** The conversion already recorded for the replacement of the latest attempt, if any (the newest one for it). */
export interface FundingFacts {
  forAttemptId: string;
  state: ConversionState;
  conversionId: string | null;
  buyCurrency: string;
  buyMinor: number;
  sellCurrency: string;
  sellMinor: number;
}

export interface IncidentFacts {
  obligation: Pick<Obligation, "id" | "amountMinor" | "currency" | "status" | "escalationReason">;
  /** Ordered by seq. */
  attempts: Attempt[];
  /** When the latest attempt was first seen PAID. */
  paidObservedAt: string | null;
  /** When the latest attempt was last seen becoming FAILED. */
  failedObservedAt: string | null;
  /** Replacements already made under a POLICY (non-human) approval for this invoice. */
  automaticReplacements: number;
  /** Available balance of every wallet, minor units by currency. Null when the balances could not be read (fails closed). */
  wallets: Record<string, number> | null;
  /**
   * Indicative rates for funding the obligation's currency: units of each source currency one unit of it costs. Read only
   * when a replacement would need funding; a missing or null entry is a rate that could not be read, so that source is not used.
   */
  fxRates: Record<string, number | null>;
  funding: FundingFacts | null;
  evidence: SupplierEvidence | null;
  now: Date;
}

export interface ReplacementAssessment {
  failureClass: FailureClass;
  policy: ReplacePolicy;
  /** What must change before an automatic replacement is acceptable, if anything. */
  needsChange: string | null;
  autoApprovable: boolean;
}

/** How a replacement measures against its wallet: what it needs, what may be spent, and what is missing. */
export interface FundingNeed {
  currency: string;
  /** The replacement's amount plus its fee (the last attempt's fee: Tessera never hardcodes one). */
  neededMinor: number;
  feeMinor: number;
  availableMinor: number;
  floorMinor: number;
  /** Missing to pay and keep the floor; zero or less when the wallet covers it. */
  shortfallMinor: number;
  /** What a conversion buys: the shortfall, rounded up to the smallest conversion. */
  buyMinor: number;
  /** The smallest conversion for this currency, so a reader can tell a rounded-up buy from the shortfall itself. */
  minConversionMinor: number;
}

/** One wallet considered as a source, and why it can or cannot fund. */
export interface FundingSourceCheck {
  currency: string;
  availableMinor: number;
  floorMinor: number;
  /** Indicative units of this currency per unit bought; null when it could not be read. */
  rate: number | null;
  /** Indicative cost of the buy in this currency, rounded up; null without a rate. */
  sellMinor: number | null;
  ok: boolean;
}

/**
 * A conversion computed by code: which wallet to sell, what to buy, and whether the Commander may book it on its own.
 * The sell amount is indicative; the booking uses a fresh quote and is refused if the quote drifts from it.
 */
export interface FundingPlan extends FundingNeed {
  forAttemptId: string;
  feasible: boolean;
  sellCurrency: string | null;
  sellMinor: number | null;
  rate: number | null;
  sources: FundingSourceCheck[];
  /** Largest automatic conversion for this currency; null means a person always approves. */
  limitMinor: number | null;
  autoApprovable: boolean;
  /** The arithmetic in plain English. */
  summary: string;
}

export interface Decision {
  recommended: ActionKind;
  /** Actions that are safe to take now. `recommended` is always one of them. */
  allowed: ActionKind[];
  /** Actions someone might expect, and why the code refuses them. */
  blocked: Array<{ action: ActionKind; reason: string }>;
  reasons: string[];
  severity: Severity;
  recheckAt: string | null;
  replacement: ReplacementAssessment | null;
  /** Set when a replacement needs another wallet's money first: the plan, feasible or not. */
  funding: FundingPlan | null;
}

const SEVERITY_RANK: Record<Severity, number> = { ROUTINE: 0, ATTENTION: 1, CRITICAL: 2 };
const DEFAULT_MIN_CONVERSION_MINOR = 100;

/**
 * What replacing `replaced` would need from its wallet. Shared by the Commander (to plan) and the funding executor (to
 * re-check against balances read just before booking), so both measure the same thing.
 */
export function fundingNeed(replaced: Pick<Attempt, "amountMinor" | "feeMinor" | "currency">, wallets: Record<string, number>, policy: CommanderPolicy): FundingNeed {
  const currency = replaced.currency;
  const feeMinor = replaced.feeMinor ?? 0;
  const neededMinor = replaced.amountMinor + feeMinor;
  const availableMinor = wallets[currency] ?? 0;
  const floorMinor = policy.reserveFloorMinor[currency] ?? 0;
  const shortfallMinor = neededMinor + floorMinor - availableMinor;
  const minConversionMinor = policy.minConversionMinor[currency] ?? DEFAULT_MIN_CONVERSION_MINOR;
  return {
    currency, neededMinor, feeMinor, availableMinor, floorMinor, shortfallMinor,
    buyMinor: Math.max(shortfallMinor, minConversionMinor), minConversionMinor,
  };
}

/** Minor units of `sellCurrency` that `buyMinor` of `buyCurrency` costs at `rate` (sell per buy), rounded up: planning errs high. */
export function sellMinorFor(buyMinor: number, buyCurrency: string, sellCurrency: string, rate: number): number {
  // The epsilon keeps a product like 3580.0000000001 (float noise) from rounding up a whole cent.
  return Math.ceil(fromMinor(buyMinor, buyCurrency) * rate * 10 ** currencyExponent(sellCurrency) - 1e-6);
}

/** Plans the conversion for `need`: the first source in policy order whose wallet can pay it and still keep its floor. */
export function planFunding(need: FundingNeed, forAttemptId: string, facts: Pick<IncidentFacts, "wallets" | "fxRates">, policy: CommanderPolicy, replacementAuto: boolean): FundingPlan {
  const wallets = facts.wallets ?? {};
  const money = (minor: number, currency: string) => formatMinor(minor, currency);
  const sources: FundingSourceCheck[] = policy.fundingSources
    .filter((currency) => currency !== need.currency)
    .map((currency) => {
      const rate = facts.fxRates[currency] ?? null;
      const availableMinor = wallets[currency] ?? 0;
      const floorMinor = policy.reserveFloorMinor[currency] ?? 0;
      const sellMinor = rate === null ? null : sellMinorFor(need.buyMinor, need.currency, currency, rate);
      return { currency, availableMinor, floorMinor, rate, sellMinor, ok: sellMinor !== null && availableMinor - sellMinor >= floorMinor };
    });
  const chosen = sources.find((s) => s.ok) ?? null;
  const limit = policy.autoConvertLimitMinor[need.currency];
  const autoApprovable = chosen !== null && replacementAuto && limit !== undefined && need.buyMinor <= limit;

  const spendable = Math.max(need.availableMinor - need.floorMinor, 0);
  const lines = [
    `The ${need.currency} wallet holds ${money(need.availableMinor, need.currency)} and keeps a ${money(need.floorMinor, need.currency)} reserve, so ${money(spendable, need.currency)} can be spent; the replacement needs ${money(need.neededMinor, need.currency)} (${money(need.neededMinor - need.feeMinor, need.currency)} plus the ${money(need.feeMinor, need.currency)} fee the last attempt cost).`,
    `It is ${money(need.shortfallMinor, need.currency)} short${need.buyMinor > need.shortfallMinor ? `, rounded up to the smallest conversion, ${money(need.buyMinor, need.currency)}` : ""}.`,
  ];
  const describe = (s: FundingSourceCheck): string =>
    s.sellMinor === null
      ? `${s.currency}: no rate could be read`
      : `${s.currency} holds ${money(s.availableMinor, s.currency)} and keeps ${money(s.floorMinor, s.currency)}, and buying ${money(need.buyMinor, need.currency)} costs about ${money(s.sellMinor, s.currency)}`;
  if (chosen) {
    lines.push(`Plan: buy ${money(need.buyMinor, need.currency)} with about ${money(chosen.sellMinor!, chosen.currency)} from the ${chosen.currency} wallet (${describe(chosen)}).`);
    lines.push(
      autoApprovable
        ? `That is within the ${money(limit!, need.currency)} automatic conversion limit.`
        : limit === undefined
          ? `There is no automatic conversion limit for ${need.currency}, so a person approves the quote.`
          : need.buyMinor > limit
            ? `That is above the ${money(limit, need.currency)} automatic conversion limit, so a person approves the quote.`
            : "The replacement itself needs a person's approval, so the conversion does too.",
    );
  } else {
    lines.push(sources.length === 0 ? "No other wallet is allowed to fund it." : `No wallet can fund it and keep its own reserve: ${sources.map(describe).join("; ")}.`);
  }
  return {
    ...need, forAttemptId, feasible: chosen !== null, sellCurrency: chosen?.currency ?? null, sellMinor: chosen?.sellMinor ?? null,
    rate: chosen?.rate ?? null, sources, limitMinor: limit ?? null, autoApprovable, summary: lines.join(" "),
  };
}

export function decide(facts: IncidentFacts, policy: CommanderPolicy = DEFAULT_POLICY): Decision {
  const { obligation, evidence, now } = facts;
  const latest = facts.attempts.at(-1) ?? null;

  const candidates: ActionKind[] = [];
  const blocked: Decision["blocked"] = [];
  const reasons: string[] = [];
  let severity: Severity = "ROUTINE";
  let recheckAt: string | null = null;
  let replacement: ReplacementAssessment | null = null;
  let funding: FundingPlan | null = null;
  /** The one refusal of REPLACE that funding answers ("fund it first"); any other refusal of REPLACE also refuses FUND. */
  let fundFirst: Decision["blocked"][number] | null = null;
  let forced: ActionKind | null = null;
  let fromState: ActionKind = "NONE";

  const raise = (next: Severity) => {
    if (SEVERITY_RANK[next] > SEVERITY_RANK[severity]) severity = next;
  };
  const refuse = (action: ActionKind, reason: string) => blocked.push({ action, reason });
  const finish = (): Decision => {
    // Money is converted only for a replacement the code would otherwise make: an escalation, a bank-detail change or any
    // other refusal of REPLACE refuses FUND too, whatever the wallets say.
    if (candidates.includes("FUND") && blocked.some((b) => b.action === "REPLACE" && b !== fundFirst)) {
      refuse("FUND", "The replacement itself is not allowed, so there is nothing to fund.");
      funding = null;
      if (forced === null && fromState === "FUND") forced = "ESCALATE";
      candidates.push("ESCALATE");
    }
    const recommended = forced ?? fromState;
    const refused = new Set(blocked.map((b) => b.action));
    const allowed = [...new Set([recommended, ...candidates])].filter((a) => a === "NONE" || !refused.has(a));
    return { recommended, allowed, blocked, reasons, severity, recheckAt, replacement, funding };
  };

  if (obligation.status === "CLOSED") {
    reasons.push("This invoice is settled and certified.");
    return finish();
  }
  if (!latest) {
    reasons.push("No payment has been attempted yet, so there is nothing to command.");
    return finish();
  }

  // 1. Signals that override the state machine: a human must look.
  if (obligation.status === "ESCALATED") {
    forced = "ESCALATE";
    raise("CRITICAL");
    candidates.push("ESCALATE");
    reasons.push(`Already with a person: ${(obligation.escalationReason ?? "no reason recorded").replace(/[.\s]+$/, "")}.`);
    refuse("REPLACE", "Only a named person can release an escalated invoice.");
    refuse("CLOSE", "An escalated invoice cannot be closed until a person resolves the escalation.");
  }
  if (evidence?.requestsDetailChange) {
    forced = "ESCALATE";
    raise("CRITICAL");
    candidates.push("ESCALATE");
    reasons.push("The supplier's message asks to change bank details. Confirm by calling a number you already hold. A bank-detail change by message is the classic payment-fraud pattern.");
    refuse("REPLACE", "New bank details arrived by message and have not been verified.");
  }
  if (evidence?.containsEmbeddedInstructions) {
    raise("ATTENTION");
    reasons.push("The supplier's message contained instructions aimed at the assistant. They were ignored.");
  }
  if (evidence && !evidence.referencesObligation) {
    raise("ATTENTION");
    reasons.push("The message does not cite this invoice's reference, so its claims are treated as unmatched.");
  }
  const statementShowsCredit =
    evidence?.statementCredit != null &&
    evidence.statementCredit.currency === obligation.currency &&
    evidence.statementCredit.amountMinor === obligation.amountMinor;
  // A credit can only add caution (see the cancelled-transfer branch) unless an operator entered it: a statement that
  // arrived by message can be spoofed, so on a PAID transfer it never lifts a supplier's non-receipt claim.
  const creditConfirmsReceipt = statementShowsCredit && evidence?.creditSource === "manual";

  // 2. The state of the latest attempt.
  switch (latest.state) {
    case "INTENT":
      fromState = "RECOVER_INTENT";
      candidates.push("RECOVER_INTENT", "ESCALATE");
      raise("ATTENTION");
      reasons.push("A payment was recorded but its outcome is unknown. Tessera will look it up by its request ID before doing anything else.");
      refuse("REPLACE", "The unresolved request still holds the lock, and a second payment could duplicate it.");
      break;

    case "LIVE": {
      refuse("REPLACE", "The original payment may still arrive. Replacing it could pay the supplier twice.");
      if (latest.awxStatus === "FAILED") {
        const failedAt = Date.parse(facts.failedObservedAt ?? latest.updatedAt);
        if (now.getTime() - failedAt > policy.failedSlaMs) {
          fromState = "ESCALATE";
          candidates.push("ESCALATE", "WAIT");
          raise("ATTENTION");
          reasons.push(`Airwallex marked the transfer as failed over ${span(policy.failedSlaMs)} ago and has not cancelled it. A person should chase the cancellation; the lock still holds.`);
          break;
        }
        fromState = "WAIT";
        candidates.push("WAIT");
        recheckAt = new Date(Math.min(now.getTime() + 5 * 60_000, failedAt + policy.failedSlaMs)).toISOString();
        reasons.push("Airwallex has marked the transfer as failed. The money returns to the wallet only once it is cancelled, so the lock holds until then.");
        break;
      }
      const slaMs = policy.settlementSlaMs[latest.method];
      const ageMs = now.getTime() - Date.parse(latest.createdAt);
      if (ageMs <= slaMs) {
        fromState = "WAIT";
        candidates.push("WAIT", "SEND_STATUS_TO_SUPPLIER");
        recheckAt = new Date(Date.parse(latest.createdAt) + slaMs).toISOString();
        reasons.push(`Processing for ${span(ageMs)} of an expected ${span(slaMs)} on ${latest.method}. Waiting is the right call.`);
        if (evidence?.claimsNonReceipt) {
          raise("ATTENTION");
          reasons.push("The supplier reports non-receipt, but the transfer is still inside its normal settlement window.");
        }
      } else {
        fromState = "ESCALATE";
        candidates.push("ESCALATE", "WAIT");
        raise("ATTENTION");
        reasons.push(`Processing for ${span(ageMs)}, beyond the expected ${span(slaMs)}. Non-delivery cannot be proven from here, so ask Airwallex to trace the payment.`);
      }
      break;
    }

    case "PAID": {
      refuse("REPLACE", "The money has left your account and may be sitting at the supplier's bank.");
      if (evidence?.claimsNonReceipt && !creditConfirmsReceipt) {
        fromState = "SEND_PROOF_TO_SUPPLIER";
        candidates.push("SEND_PROOF_TO_SUPPLIER", "ESCALATE", "WAIT");
        raise("ATTENTION");
        reasons.push("Airwallex reports the payment as made, yet the supplier says nothing arrived. Send proof of payment and ask their bank to trace it. Do not pay again.");
        break;
      }
      if (creditConfirmsReceipt) reasons.push("The supplier's own statement, entered by an operator, shows the credit, which confirms receipt.");
      const heldMs = facts.paidObservedAt ? now.getTime() - Date.parse(facts.paidObservedAt) : 0;
      if (facts.paidObservedAt && heldMs >= policy.paidHoldMs) {
        fromState = "CLOSE";
        candidates.push("CLOSE");
        reasons.push("The payment has stayed paid through the hold window with no return. It can now be reconciled and certified.");
      } else {
        fromState = "WAIT";
        candidates.push("WAIT");
        recheckAt = facts.paidObservedAt ? new Date(Date.parse(facts.paidObservedAt) + policy.paidHoldMs).toISOString() : null;
        reasons.push("Paid is not final: a bank can still return a payment. Wait out the hold before closing.");
      }
      break;
    }

    case "DEAD": {
      const entry = lookupFailure(latest.failureCode);
      reasons.push(`Attempt ${latest.seq} was cancelled with failure ${latest.failureCode ?? "(no code)"}. ${entry.guidance}`);
      replacement = {
        failureClass: entry.class,
        policy: entry.replace,
        needsChange: entry.change ? entry.change.toLowerCase() : null,
        autoApprovable: false,
      };

      if (statementShowsCredit) {
        forced = "ESCALATE";
        raise("CRITICAL");
        candidates.push("ESCALATE");
        reasons.push("The supplier's statement shows the full amount, yet Airwallex cancelled the transfer. The supplier may already hold the money.");
        refuse("REPLACE", "A replacement could pay the supplier twice.");
        break;
      }
      if (entry.replace === "FORBIDDEN") {
        fromState = "ESCALATE";
        candidates.push("ESCALATE");
        raise(entry.class === "POSSIBLE_DUPLICATE" || entry.class === "COMPLIANCE_OR_RECALL" ? "CRITICAL" : "ATTENTION");
        refuse("REPLACE", "This kind of failure is never replaced automatically. A named person must approve it, in writing.");
        break;
      }
      if (entry.replace === "AFTER_CHANGE") {
        fromState = "REQUEST_CORRECTION";
        candidates.push("REQUEST_CORRECTION", "ESCALATE");
        raise("ATTENTION");
        refuse("REPLACE", `Needs a changed ${replacement.needsChange} first, or an approval from a person with a written reason.`);
        break;
      }

      // A replacement pays its own fee; the previous attempt's fee is the best estimate of it (`fundingNeed`).
      const limit = policy.autoReplaceLimitMinor[obligation.currency];
      const withinLimit = limit !== undefined && latest.amountMinor <= limit;
      const conversion = facts.funding?.forAttemptId === latest.id ? facts.funding : null;
      const bought = conversion
        ? `${formatMinor(conversion.buyMinor, conversion.buyCurrency)} for ${formatMinor(conversion.sellMinor, conversion.sellCurrency)}`
        : "";
      if (facts.automaticReplacements >= policy.maxAutoReplacements) {
        fromState = "ESCALATE";
        candidates.push("ESCALATE", "REPLACE");
        raise("ATTENTION");
        reasons.push(`This invoice has already been replaced automatically ${facts.automaticReplacements} times. Repeated failures need a person's eyes before paying again.`);
      } else if (facts.wallets === null) {
        fromState = "REPLACE";
        candidates.push("REPLACE", "ESCALATE");
        raise("ATTENTION");
        reasons.push("The wallet balances could not be read, so the replacement cannot be approved automatically. A person must confirm the funds.");
      } else if (conversion && (conversion.state === "INTENT" || conversion.state === "BOOKED")) {
        fromState = "WAIT";
        candidates.push("WAIT", "ESCALATE");
        raise("ATTENTION");
        recheckAt = new Date(now.getTime() + 60_000).toISOString();
        reasons.push(
          conversion.state === "INTENT"
            ? `A conversion to fund this replacement (${bought}) is recorded but its outcome is unknown. Tessera looks it up by its request ID before anything else.`
            : `The conversion that funds this replacement (${bought}) is booked but has not settled, so the money is not in the wallet yet.`,
        );
        refuse("REPLACE", "The conversion that funds it has not settled yet.");
        refuse("FUND", "This replacement already has a conversion; Tessera books one per replacement.");
      } else {
        const need = fundingNeed(latest, facts.wallets, policy);
        const fundedBy = conversion?.state === "SETTLED" ? ` It was funded by conversion ${conversion.conversionId ?? "(no id)"}: ${bought}.` : "";
        if (need.shortfallMinor <= 0 && withinLimit) {
          fromState = "REPLACE";
          candidates.push("REPLACE", "ESCALATE");
          replacement.autoApprovable = true;
          reasons.push(`A temporary fault: the original is cancelled and the money is back in the wallet. A replacement is within the automatic limit.${fundedBy}`);
        } else if (need.shortfallMinor <= 0) {
          fromState = "REPLACE";
          candidates.push("REPLACE", "ESCALATE");
          raise("ATTENTION");
          reasons.push(`A replacement is allowed but exceeds the automatic limit, so a person must approve it.${fundedBy}`);
        } else if (conversion?.state === "SETTLED") {
          fromState = "ESCALATE";
          candidates.push("ESCALATE");
          raise("ATTENTION");
          reasons.push(
            `This replacement was already funded once (${bought}), yet the ${need.currency} wallet holds ${formatMinor(need.availableMinor, need.currency)}, keeps ${formatMinor(need.floorMinor, need.currency)} and the replacement needs ${formatMinor(need.neededMinor, need.currency)}. Tessera books one conversion per replacement, so a person must look.`,
          );
          refuse("REPLACE", "The wallet balance is too low.");
          refuse("FUND", "This replacement already had its conversion; Tessera books one per replacement.");
        } else {
          const plan = planFunding(need, latest.id, facts, policy, withinLimit);
          funding = plan;
          reasons.push(plan.summary);
          if (plan.feasible) {
            fromState = "FUND";
            candidates.push("FUND", "ESCALATE");
            if (!plan.autoApprovable) raise("ATTENTION");
            fundFirst = { action: "REPLACE", reason: `The ${need.currency} wallet is ${formatMinor(need.shortfallMinor, need.currency)} short; fund it first.` };
            blocked.push(fundFirst);
          } else {
            fromState = "ESCALATE";
            candidates.push("ESCALATE");
            raise("ATTENTION");
            refuse("REPLACE", "The wallet balance is too low, and no other wallet can fund it.");
            refuse("FUND", "No wallet can fund it and keep its own reserve.");
          }
        }
      }
      break;
    }

    case "ABANDONED":
      fromState = "REQUEST_CORRECTION";
      candidates.push("REQUEST_CORRECTION", "REPLACE", "ESCALATE");
      raise("ATTENTION");
      reasons.push(`Airwallex rejected the request outright (${latest.lastError ?? "no detail"}), so nothing was sent. Correct the terms and try again.`);
      break;
  }

  return finish();
}
