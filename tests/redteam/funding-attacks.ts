/**
 * Attacks 31-40: funding a replacement from another wallet. Each runs against the real Commander, funding executor,
 * ledger, Closer and toolbox over the fake Airwallex, which converts the way the sandbox did on 2026-11-03 (quotes are
 * MULTI_USE, a reused request_id is refused without naming the conversion, conversions settle at once). The prize in
 * every one is the same: convert money that is not needed, convert it twice, drain a reserve, or certify books that do
 * not tie.
 */
import { createHmac } from "node:crypto";
import { createToolbox, type Toolbox } from "../../src/agent/toolbox";
import type { Conversion, CreateConversionRequest } from "../../src/airwallex/types";
import { FakePayoutApi } from "../../src/airwallex/fake";
import { canonicalJson } from "../../src/canonical";
import { formatMinor } from "../../src/money";
import { fundingApproval, fundWorld, SHORTFALL_MINOR, type FundWorld } from "../helpers/fund-world";
import { SECRET } from "../helpers/world";
import type { Attack } from "./attacks";

const NOTE = "checked the rate with treasury before converting";

const agentToolbox = (w: FundWorld): Toolbox =>
  createToolbox({ ledger: w.ledger, gateway: w.gateway, commander: w.commander, closer: w.closer, model: null, actor: "agent:redteam", acceptClientText: false });

const conversions = (w: FundWorld): string => `${w.api.conversions.size} conversion${w.api.conversions.size === 1 ? "" : "s"} at Airwallex`;
const errorName = (error: unknown): string => (error instanceof Error ? `${error.name}${"reason" in error ? ` (${String(error.reason)})` : ""}` : "nothing");

/** An Airwallex that books the conversion and then never answers, so the process can be "killed" while it waits. */
class HangsAfterBooking extends FakePayoutApi {
  hang = true;
  readonly booked = Promise.withResolvers<void>();
  override async createConversion(request: CreateConversionRequest): Promise<Conversion> {
    const conversion = await super.createConversion(request);
    if (!this.hang) return conversion;
    this.booked.resolve();
    return new Promise<Conversion>(() => {});
  }
}

export const FUNDING_ATTACKS: Attack[] = [
  {
    id: "fund-smuggled-terms",
    title: "Name the amount, the wallet and the rate of a conversion",
    trick: "Call fund_replacement with buyAmountMinor 100,000,000, sellCurrency GBP and rate 0.01, hoping the tool converts on the agent's terms.",
    layer: "Policy",
    async run() {
      const w = await fundWorld();
      const toolbox = agentToolbox(w);
      const smuggled = await toolbox.call("fund_replacement", { incidentId: w.obligation.id, buyAmountMinor: 100_000_000, sellCurrency: "GBP", rate: 0.01 });
      const plain = await toolbox.call("fund_replacement", { incidentId: w.obligation.id });
      const [booked] = w.ledger.conversionsFor(w.obligation.id);
      return {
        held: !smuggled.ok && smuggled.kind === "invalid" && plain.ok && w.api.conversions.size === 1 && booked?.buyMinor === SHORTFALL_MINOR && booked.sellCurrency === "USD",
        stoppedBy: "fund_replacement's strict schema takes an incident id only; the plan, the quote and the amounts are code's",
        observed: `smuggled call ${smuggled.ok ? "accepted" : smuggled.kind}; the plain call bought ${booked ? formatMinor(booked.buyMinor, booked.buyCurrency) : "nothing"} with ${booked?.sellCurrency ?? "-"} (the shortfall)`,
      };
    },
  },
  {
    id: "fund-twice",
    title: "Convert twice for one replacement",
    trick: "Call fund_replacement again once the first conversion settled, then write a second conversion row straight into the database as a caller that skipped every check would.",
    layer: "Database",
    async run() {
      const w = await fundWorld();
      const toolbox = agentToolbox(w);
      await toolbox.call("fund_replacement", { incidentId: w.obligation.id });
      const again = await toolbox.call("fund_replacement", { incidentId: w.obligation.id });
      const [first] = w.ledger.conversionsFor(w.obligation.id);
      let direct = "accepted";
      try {
        w.ledger.insertConversion({ ...first!, quoteId: "q-direct", requestId: crypto.randomUUID(), approvalNonce: "n".repeat(32) });
      } catch (error) {
        direct = errorName(error);
      }
      return {
        held: !again.ok && direct === "DuplicateConversionError" && w.api.conversions.size === 1,
        stoppedBy: `assessment no longer allows FUND (${again.ok ? "allowed" : again.kind}); the one_conversion_per_replacement index refused the direct row (${direct})`,
        observed: conversions(w),
      };
    },
  },
  {
    id: "fund-two-processes",
    title: "Two processes convert for the same replacement at once",
    trick: "Two executors (the API and the MCP server on one ledger) each hold a valid, signed approval for a different quote and book at the same moment.",
    layer: "Database",
    async run() {
      const w = await fundWorld();
      const [a, b] = [await fundingApproval(w), await fundingApproval(w)];
      const results = await Promise.allSettled([w.executor.book(a), w.executorWith().book(b)]);
      const refused = results.flatMap((r) => (r.status === "rejected" ? [errorName(r.reason)] : []));
      return {
        held: w.api.conversions.size === 1 && refused.length === 1 && w.ledger.conversionsFor(w.obligation.id).length === 1,
        stoppedBy: `the intent is committed in one transaction under the partial unique index; the loser got ${refused.join(", ") || "nothing"}`,
        observed: conversions(w),
      };
    },
  },
  {
    id: "fund-replay-approval",
    title: "Replay a funding approval, or pass a payout signature off as one",
    trick: "Book a spent funding approval a second time, and sign a funding payload the way payout approvals are signed (no funding domain).",
    layer: "Approvals",
    async run() {
      const w = await fundWorld();
      const approval = await fundingApproval(w);
      await w.executor.book(approval);
      const replay = await w.executor.book(approval).catch((e: unknown) => e);
      const other = await fundingApproval(w);
      const crossDomain = { ...other, mac: createHmac("sha256", SECRET).update(canonicalJson(other.payload)).digest("hex") };
      const forged = await w.executor.book(crossDomain).catch((e: unknown) => e);
      return {
        held: errorName(replay) === "ApprovalRejected (replayed)" && errorName(forged) === "ApprovalRejected (bad_signature)" && w.api.conversions.size === 1,
        stoppedBy: `nonce spent: ${errorName(replay)}; MAC domain tessera-funding-v1: ${errorName(forged)}`,
        observed: conversions(w),
      };
    },
  },
  {
    id: "fund-stale-quote",
    title: "Approve a quote other than the one reviewed",
    trick: "A person reviews a quote; another is fetched, the clock runs past the policy's quote age, and the approval for the first one (and then the old fingerprint) is sent anyway.",
    layer: "Approvals",
    async run() {
      let clock = Date.now();
      const w = await fundWorld({ policy: { autoConvertLimitMinor: {} }, now: () => new Date(clock) });
      const reviewed = await w.commander.quoteForReview(w.obligation.id);
      const input = { obligationId: w.obligation.id, approver: "ops@acme.example", note: NOTE, evidenceHash: reviewed.evidenceHash, quoteId: reviewed.quoteId, fingerprint: reviewed.fingerprint };
      const newer = await w.commander.quoteForReview(w.obligation.id);
      const superseded = await w.commander.approveFunding(input).catch((e: unknown) => e);
      clock += w.policy.maxQuoteAgeMs + 1_000;
      const old = await w.commander.approveFunding({ ...input, quoteId: newer.quoteId, fingerprint: newer.fingerprint }).catch((e: unknown) => e);
      return {
        held: errorName(superseded) === "ApprovalRejected (stale)" && errorName(old) === "FundingRefused" && w.api.conversionCalls === 0,
        stoppedBy: `only the latest recorded quote, with its fingerprint: ${errorName(superseded)}; maxQuoteAgeMs: ${errorName(old)}`,
        observed: `${w.api.conversionCalls} conversion requests sent`,
      };
    },
  },
  {
    id: "fund-drain-reserve",
    title: "Fund a replacement by draining another wallet's reserve",
    trick: "Leave the USD wallet $10 above its floor, the GBP wallet at its floor, and ask for the conversion: the only way to pay is to break a reserve.",
    layer: "Policy",
    async run() {
      const w = await fundWorld();
      w.api.balances.set("USD", 1_010);
      w.api.balances.set("GBP", 1_000);
      const asked = await agentToolbox(w).call("fund_replacement", { incidentId: w.obligation.id });
      const direct = await w.executor.book(await fundingApproval(w)).catch((e: unknown) => e);
      return {
        held: !asked.ok && errorName(direct) === "FundingRefused" && w.api.conversionCalls === 0 && w.api.balanceOf("USD") === 1_010,
        stoppedBy: `planFunding finds no source that keeps its floor (${asked.ok ? "allowed" : asked.kind}); the executor re-checks the source floor on fresh balances (${errorName(direct)})`,
        observed: `USD wallet still ${w.api.balanceOf("USD")}, GBP ${w.api.balanceOf("GBP")}; ${w.api.conversionCalls} conversion requests`,
      };
    },
  },
  {
    id: "fund-overconvert-signed",
    title: "A signed approval to convert ten times the shortfall",
    trick: "With the signing key (a compromised Commander), sign an approval to buy ten times what is missing at a real quote, and hand it straight to the executor.",
    layer: "Gateway",
    async run() {
      const w = await fundWorld();
      // Signed with the real key (fundingApproval signs as the Commander would) for a real quote of ten times the need.
      const signed = await fundingApproval(w, { buyMinor: SHORTFALL_MINOR * 10 });
      const refused = await w.executor.book(signed).catch((e: unknown) => e);
      return {
        held: errorName(refused) === "FundingRefused" && w.api.conversionCalls === 0,
        stoppedBy: `the executor re-reads the wallets and books exactly the shortfall, never more: ${errorName(refused)}`,
        observed: `${w.api.conversionCalls} conversion requests; EUR wallet ${w.api.balanceOf("EUR")}`,
      };
    },
  },
  {
    id: "fund-kill-mid-conversion",
    title: "Kill the process between the conversion request and its answer",
    trick: "Airwallex books the conversion, the process dies before the reply, and on restart the agent asks to fund again.",
    layer: "Gateway",
    async run() {
      const api = new HangsAfterBooking();
      const w = await fundWorld({ api });
      void w.executor.book(await fundingApproval(w));
      await api.booked.promise;
      api.hang = false;
      const restarted = w.executorWith();
      const [recovered] = await restarted.recover();
      const again = await agentToolbox(w).call("fund_replacement", { incidentId: w.obligation.id });
      return {
        held: recovered?.conversion.state === "SETTLED" && !again.ok && w.api.conversions.size === 1 && w.api.conversionCalls === 1,
        stoppedBy: `intent before network; recovery looked the same request_id up (${recovered?.outcome ?? "nothing"}) and minted none`,
        observed: `${conversions(w)}, ${w.api.conversionCalls} create call; the repeat was ${again.ok ? "granted" : again.kind}`,
      };
    },
  },
  {
    id: "fund-delete-conversion-row",
    title: "Delete the settled conversion to convert again",
    trick: "Delete the conversions row (freeing the one-per-replacement lock), then book a fresh, validly signed approval.",
    layer: "Hash chain",
    async run() {
      const w = await fundWorld();
      const { result } = await w.commander.fundAutomatically(w.obligation.id);
      w.ledger.db.query("DELETE FROM conversions WHERE id = ?").run(result.conversion.id);
      const chain = w.ledger.verifyChain();
      const again = await w.executor.book(await fundingApproval(w)).catch((e: unknown) => e);
      return {
        held: !chain.ok && errorName(again) === "ObligationNotPayable" && w.api.conversions.size === 1,
        stoppedBy: `verifyChain replays FUNDING_INTENT: ${chain.ok ? "ok" : chain.reason}; nothing is converted on a ledger that does not verify`,
        observed: conversions(w),
      };
    },
  },
  {
    id: "fund-certify-untied-conversion",
    title: "Certify a funded invoice whose conversion does not tie",
    trick: "After the funded replacement is paid, Airwallex shows an extra fee line against the conversion and a bought leg one cent short; ask for the certificate.",
    layer: "Closer",
    async run() {
      const w = await fundWorld();
      const toolbox = agentToolbox(w);
      await toolbox.call("fund_replacement", { incidentId: w.obligation.id });
      const { attempt } = await w.commander.replaceAutomatically(w.obligation.id);
      w.api.advance(attempt.transferId!, "SENT");
      w.api.advance(attempt.transferId!, "PAID");
      await w.gateway.sync(w.obligation.id);
      const [conversion] = w.ledger.conversionsFor(w.obligation.id);
      w.api.line(conversion!.conversionId!, "CONVERSION", "FEE", "USD", -1);
      w.api.wallet.get(conversion!.conversionId!)!.find((l) => l.transaction_type === "CONVERSION_BUY")!.net -= 0.01;
      const closed = await toolbox.call("reconcile_and_close", { incidentId: w.obligation.id });
      return {
        held: !closed.ok && w.ledger.requireObligation(w.obligation.id).status !== "CLOSED" && w.ledger.getCertificateJson(w.obligation.id) === null,
        stoppedBy: "the Closer ties both legs of every conversion to Airwallex's CONVERSION_BUY / CONVERSION_SELL lines",
        observed: closed.ok ? "certified" : `refused: ${closed.message.slice(0, 140)}`,
      };
    },
  },
];
