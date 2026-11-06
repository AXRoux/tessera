import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { FakePayoutApi } from "../src/airwallex/fake";
import type { Conversion, CreateConversionRequest } from "../src/airwallex/types";
import { canonicalJson } from "../src/canonical";
import { ApprovalRejected, DuplicateConversionError, FundingRefused, NotClosable } from "../src/errors";
import { verifyFundingApproval } from "../src/funding/approval";
import { fundingApproval, fundWorld, SELL_MINOR, SHORTFALL_MINOR, type FundWorld } from "./helpers/fund-world";
import { SECRET } from "./helpers/world";

const NOTE = "checked the rate with treasury before converting";
const OPS = "ops@acme.example";
const eventTypes = (w: FundWorld) => w.ledger.events(w.obligation.id).map((e) => e.type);

/** An Airwallex whose lookups miss a conversion for a while, as an eventually consistent list endpoint may. */
class LaggingLookups extends FakePayoutApi {
  misses = 0;
  override async findConversionByRequestId(requestId: string, fromCreatedAt?: string): Promise<Conversion | null> {
    if (this.misses > 0) {
      this.misses--;
      return null;
    }
    return super.findConversionByRequestId(requestId, fromCreatedAt);
  }
}

/** An Airwallex that books the conversion and then never answers: the process is killed while it waits. */
class HangsAfterBooking extends FakePayoutApi {
  hang = false;
  readonly booked = Promise.withResolvers<void>();
  override async createConversion(request: CreateConversionRequest): Promise<Conversion> {
    const conversion = await super.createConversion(request);
    if (!this.hang) return conversion;
    this.booked.resolve();
    return new Promise<Conversion>(() => {});
  }
}

describe("funding executor: intent before network", () => {
  it("commits the intent and its request_id before Airwallex is called, then books exactly the shortfall", async () => {
    const w = await fundWorld();
    let intentAtSend: string | null = null;
    const create = w.api.createConversion.bind(w.api);
    w.api.createConversion = async (request) => {
      intentAtSend = w.ledger.conversionsFor(w.obligation.id).find((c) => c.requestId === request.request_id)?.state ?? null;
      return create(request);
    };

    const result = await w.executor.book(await fundingApproval(w));

    expect(intentAtSend!).toBe("INTENT");
    expect(result.outcome).toBe("BOOKED");
    expect(result.conversion).toMatchObject({ state: "SETTLED", buyMinor: SHORTFALL_MINOR, sellMinor: SELL_MINOR, sellCurrency: "USD" });
    expect(w.api.balanceOf("EUR")).toBe(1_038.33);
    expect(result.walletsAfter).toMatchObject({ EUR: 103_833 });
    expect(eventTypes(w)).toEqual(expect.arrayContaining(["FUNDING_INTENT", "FUNDING_STATUS", "FUNDING_BALANCES"]));
  });

  it("resolves a lost reply by looking up the same request_id, never by converting again", async () => {
    const w = await fundWorld();
    w.api.faults.loseConversionResponse = 1;

    const result = await w.executor.book(await fundingApproval(w));

    expect(result.outcome).toBe("ADOPTED_AFTER_AMBIGUITY");
    expect(result.conversion.state).toBe("SETTLED");
    expect(w.api.conversions.size).toBe(1);
    expect(w.api.conversionCalls).toBe(1);
    expect(eventTypes(w)).toContain("FUNDING_AMBIGUOUS");
  });

  it("adopts the conversion Airwallex already holds when a resend is answered 'request_id used in the past'", async () => {
    const api = new LaggingLookups();
    const w = await fundWorld({ api });
    w.api.faults.loseConversionResponse = 1;
    api.misses = 2;

    const pending = await w.executor.book(await fundingApproval(w));
    expect(pending.outcome).toBe("PENDING_RECOVERY");

    const [recovered] = await w.executor.recover(w.obligation.id);

    // The lookup missed it, so the same request_id went out again; Airwallex refused it as used and the lookup found it.
    expect(recovered!.outcome).toBe("ADOPTED_DUPLICATE");
    expect(recovered!.conversion.requestId).toBe(pending.conversion.requestId);
    expect(w.api.conversions.size).toBe(1);
    expect(w.api.conversionCalls).toBe(2);
  });

  it("releases the lock when the first send is refused outright, so a fresh approval can convert", async () => {
    const w = await fundWorld();

    const rejected = await w.executor.book(await fundingApproval(w, { quoteId: "no-such-quote" }));

    expect(rejected.outcome).toBe("REJECTED");
    expect(rejected.conversion.state).toBe("ABANDONED");
    expect((await w.executor.book(await fundingApproval(w))).conversion.state).toBe("SETTLED");
    expect(w.api.conversions.size).toBe(1);
  });

  it("re-sends an unresolved intent under the same request_id while its quote is good", async () => {
    const w = await fundWorld();
    w.api.faults.failBeforeConversion = 1;
    w.api.faults.failConversionLookup = 1;

    const pending = await w.executor.book(await fundingApproval(w));
    expect(pending).toMatchObject({ outcome: "PENDING_RECOVERY", conversion: { state: "INTENT" } });

    const [recovered] = await w.executor.recover();

    expect(recovered!.conversion).toMatchObject({ state: "SETTLED", requestId: pending.conversion.requestId });
    expect(w.api.conversions.size).toBe(1);
  });

  it("releases an intent by itself once its quote expired and Airwallex has nothing for it, and never sends it", async () => {
    const w = await fundWorld();
    w.api.faults.failBeforeConversion = 1;
    w.api.faults.failConversionLookup = 1;
    const pending = await w.executor.book(await fundingApproval(w));
    const calls = w.api.conversionCalls;

    const late = w.executorWith({ now: () => new Date(Date.parse(pending.conversion.quoteValidTo) + 10 * 60_000 + 1) });
    const [released] = await late.recover();

    expect(released!.outcome).toBe("REJECTED");
    expect(released!.conversion.state).toBe("ABANDONED");
    expect(w.api.conversionCalls).toBe(calls);
    expect(eventTypes(w)).toContain("FUNDING_ABANDONED");
  });

  it("survives being killed between the intent and Airwallex's answer: the next process adopts the booking", async () => {
    const api = new HangsAfterBooking();
    const w = await fundWorld({ api });
    api.hang = true;

    void w.executor.book(await fundingApproval(w));
    await api.booked.promise;
    expect(w.ledger.conversionsFor(w.obligation.id).map((c) => c.state)).toEqual(["INTENT"]);

    // The process died here. A fresh one on the same ledger finds the intent and looks its request_id up.
    api.hang = false;
    const [recovered] = await w.executorWith().recover();

    expect(recovered!.outcome).toBe("ADOPTED_AFTER_AMBIGUITY");
    expect(recovered!.conversion.state).toBe("SETTLED");
    expect(w.api.conversions.size).toBe(1);
    expect(w.api.conversionCalls).toBe(1);
  });

  it("escalates, and adopts nothing, when Airwallex holds different terms under our request_id", async () => {
    const w = await fundWorld();
    w.api.faults.loseConversionResponse = 1;
    w.api.faults.failConversionLookup = 1;
    await w.executor.book(await fundingApproval(w));
    const [booked] = [...w.api.conversions.values()];
    booked!.sell_amount += 1;

    const [result] = await w.executor.recover();

    expect(result!.conversion.state).toBe("INTENT");
    expect(w.ledger.requireObligation(w.obligation.id)).toMatchObject({ status: "ESCALATED", escalationReason: expect.stringContaining("does not match the funding intent") });
    expect(eventTypes(w)).toContain("FUNDING_MISMATCH");
  });
});

describe("funding executor: one conversion per replacement", () => {
  it("refuses a second conversion for the same replacement, from the executor and from the database itself", async () => {
    const w = await fundWorld();
    const first = await w.executor.book(await fundingApproval(w));

    await expect(w.executor.book(await fundingApproval(w))).rejects.toBeInstanceOf(DuplicateConversionError);
    // A caller that skipped every executor check still meets the partial unique index.
    expect(() =>
      w.ledger.insertConversion({
        ...first.conversion, quoteId: "another-quote", requestId: crypto.randomUUID(), approvalNonce: "n".repeat(32),
      }),
    ).toThrow(DuplicateConversionError);
    expect(w.api.conversions.size).toBe(1);
  });

  it("books a quote once, even though Airwallex reports it MULTI_USE", async () => {
    const w = await fundWorld();
    const approval = await fundingApproval(w, { quoteId: "no-such-quote" });
    await w.executor.book(approval);
    const reused = await fundingApproval(w, { quoteId: "no-such-quote" });

    await expect(w.executor.book(reused)).rejects.toMatchObject({ name: "FundingRefused", reasons: [expect.stringContaining("single-use")] });
  });

  it("refuses to buy more, or less, than the shortfall on the wallets read just before booking", async () => {
    const w = await fundWorld();

    for (const buyMinor of [SHORTFALL_MINOR + 1, SHORTFALL_MINOR - 1]) {
      const refused = await w.executor.book(await fundingApproval(w, { buyMinor })).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(FundingRefused);
      expect(refused).toMatchObject({ replan: true });
    }
    expect(w.api.conversionCalls).toBe(0);
  });

  it("refuses once the wallet no longer needs it, and when selling would take the source below its floor", async () => {
    const w = await fundWorld();
    const approval = await fundingApproval(w);

    w.api.balances.set("USD", 1_010);
    await expect(w.executor.book(approval)).rejects.toMatchObject({ reasons: [expect.stringContaining("below its $1,000.00 reserve")] });

    w.api.balances.set("EUR", 2_000);
    await expect(w.executor.book(await fundingApproval(w))).rejects.toMatchObject({ reasons: [expect.stringContaining("nothing needs converting")] });
    expect(w.api.conversionCalls).toBe(0);
  });

  it("refuses when the balances cannot be read, and never sells a wallet outside the policy's sources", async () => {
    const w = await fundWorld();
    w.api.faults.failBalances = 1;

    await expect(w.executor.book(await fundingApproval(w))).rejects.toMatchObject({ reasons: [expect.stringContaining("could not be read")] });
    w.api.rates.set("EURHKD", 8.8);
    await expect(w.executor.book(await fundingApproval(w, { sellCurrency: "HKD" }))).rejects.toMatchObject({ reasons: [expect.stringContaining("not a wallet Tessera may sell")] });
    expect(w.api.conversionCalls).toBe(0);
  });

  it("converts nothing for an escalated incident", async () => {
    const w = await fundWorld();
    w.ledger.escalate(w.obligation.id, "a person is looking");

    await expect(w.executor.book(await fundingApproval(w))).rejects.toMatchObject({ name: "ObligationNotPayable" });
    expect(w.api.conversionCalls).toBe(0);
  });
});

describe("funding approvals", () => {
  it("rejects a changed amount, a payout-domain MAC, an expired approval and a replay", async () => {
    const w = await fundWorld();
    const approval = await fundingApproval(w);

    const tampered = { ...approval, payload: { ...approval.payload, buyMinor: approval.payload.buyMinor + 100 } };
    expect(() => verifyFundingApproval(tampered, SECRET, new Date())).toThrow(ApprovalRejected);
    // The same payload signed the way payout approvals are (no funding domain) is not a funding approval.
    const payoutDomain = { ...approval, mac: createHmac("sha256", SECRET).update(canonicalJson(approval.payload)).digest("hex") };
    expect(() => verifyFundingApproval(payoutDomain, SECRET, new Date())).toThrow(/MAC does not match/);
    expect(() => verifyFundingApproval(approval, SECRET, new Date(Date.parse(approval.payload.expiresAt)))).toThrow(/expired/);

    await w.executor.book(approval);
    await expect(w.executor.book(approval)).rejects.toMatchObject({ name: "ApprovalRejected", reason: "replayed" });
    expect(w.api.conversions.size).toBe(1);
  });

  it("is refused for an attempt that is no longer the latest", async () => {
    const w = await fundWorld();

    await expect(w.executor.book(await fundingApproval(w, { forAttemptId: "att-older" }))).rejects.toMatchObject({ reason: "stale" });
  });
});

describe("commander: automatic funding", () => {
  it("funds from the plan, then replaces on the balances read after the conversion settled", async () => {
    const w = await fundWorld();

    const funded = await w.commander.fundAutomatically(w.obligation.id);
    const replaced = await w.commander.replaceAutomatically(w.obligation.id);

    expect(funded.result.conversion).toMatchObject({ state: "SETTLED", buyMinor: SHORTFALL_MINOR, sellMinor: SELL_MINOR });
    expect(funded.replans).toEqual([]);
    expect(replaced.outcome).toBe("CREATED");
    // €1,011.67 + €26.66 - €25.00 - €13.33: exactly the floor is left.
    expect(w.api.balanceOf("EUR")).toBe(1_000);
  });

  it("throws away a quote whose rate drifted past the limit and re-plans on a fresh one", async () => {
    const w = await fundWorld();
    const createQuote = w.api.createQuote.bind(w.api);
    let drifted = false;
    w.api.createQuote = async (request) => {
      if (!drifted) {
        drifted = true;
        w.api.rates.set("EURUSD", 1.2);
        const quote = await createQuote(request);
        w.api.rates.set("EURUSD", 1.130824);
        return quote;
      }
      return createQuote(request);
    };

    const funded = await w.commander.fundAutomatically(w.obligation.id);

    expect(funded.replans).toEqual([expect.stringContaining("the rate moved")]);
    expect(funded.result.conversion.sellMinor).toBe(SELL_MINOR);
    expect(eventTypes(w)).toContain("FUNDING_REPLANNED");
  });

  it("gives up after three drifting quotes and converts nothing", async () => {
    const w = await fundWorld();
    const createQuote = w.api.createQuote.bind(w.api);
    w.api.createQuote = async (request) => {
      w.api.rates.set("EURUSD", 1.2);
      const quote = await createQuote(request);
      w.api.rates.set("EURUSD", 1.130824);
      return quote;
    };

    await expect(w.commander.fundAutomatically(w.obligation.id)).rejects.toMatchObject({ reasons: [expect.stringContaining("3 fresh quotes in a row")] });
    expect(w.api.conversionCalls).toBe(0);
  });

  it("asks a person above the automatic conversion limit, and books nothing on its own", async () => {
    const w = await fundWorld({ policy: { autoConvertLimitMinor: { EUR: SHORTFALL_MINOR - 1 } } });

    await expect(w.commander.fundAutomatically(w.obligation.id)).rejects.toMatchObject({ reasons: expect.arrayContaining([expect.stringContaining("needs a person's approval")]) });
    expect(w.api.conversionCalls).toBe(0);
  });
});

describe("commander: a person approves the quote (two steps)", () => {
  const review = async () => {
    const w = await fundWorld({ policy: { autoConvertLimitMinor: {} } });
    const quote = await w.commander.quoteForReview(w.obligation.id);
    return { w, quote, input: { obligationId: w.obligation.id, approver: OPS, note: NOTE, evidenceHash: quote.evidenceHash, quoteId: quote.quoteId, fingerprint: quote.fingerprint } };
  };

  it("books the reviewed quote under the person's name", async () => {
    const { w, quote, input } = await review();

    const result = await w.commander.approveFunding(input);

    expect(result.conversion).toMatchObject({ state: "SETTLED", quoteId: quote.quoteId, buyMinor: SHORTFALL_MINOR });
    expect(w.ledger.events(w.obligation.id).find((e) => e.type === "FUNDING_INTENT")?.payload).toMatchObject({ mode: "HUMAN", approver: OPS, note: NOTE });
  });

  it("refuses a fingerprint that is not the one shown, a quote that is not the latest, and a missing note", async () => {
    const { w, input } = await review();

    await expect(w.commander.approveFunding({ ...input, fingerprint: "f".repeat(64) })).rejects.toMatchObject({ reason: "stale" });
    await expect(w.commander.approveFunding({ ...input, note: "ok" })).rejects.toThrow();
    const newer = await w.commander.quoteForReview(w.obligation.id);
    await expect(w.commander.approveFunding(input)).rejects.toMatchObject({ reason: "stale" });
    expect((await w.commander.approveFunding({ ...input, quoteId: newer.quoteId, fingerprint: newer.fingerprint, evidenceHash: newer.evidenceHash })).conversion.state).toBe("SETTLED");
    expect(w.api.conversions.size).toBe(1);
  });

  it("refuses once the incident changed since the review", async () => {
    const { w, input } = await review();
    w.api.balances.set("EUR", 1_012);

    await expect(w.commander.approveFunding(input)).rejects.toMatchObject({ reason: "stale_evidence" });
    expect(w.api.conversionCalls).toBe(0);
  });

  it("refuses a reviewed quote older than the policy's maximum age, though Airwallex would still take it", async () => {
    let clock = Date.now();
    const w = await fundWorld({ policy: { autoConvertLimitMinor: {} }, now: () => new Date(clock) });
    const quote = await w.commander.quoteForReview(w.obligation.id);

    clock += w.policy.maxQuoteAgeMs + 1_000;
    const input = { obligationId: w.obligation.id, approver: OPS, note: NOTE, evidenceHash: quote.evidenceHash, quoteId: quote.quoteId, fingerprint: quote.fingerprint };

    expect(Date.parse(quote.validTo)).toBeGreaterThan(clock);
    await expect(w.commander.approveFunding(input)).rejects.toMatchObject({ name: "FundingRefused", reasons: [expect.stringContaining("older than 5 minutes")] });
    expect(w.api.conversionCalls).toBe(0);
  });
});

describe("closer: a funded replacement", () => {
  async function fundedAndPaid() {
    const w = await fundWorld();
    await w.commander.fundAutomatically(w.obligation.id);
    const { attempt } = await w.commander.replaceAutomatically(w.obligation.id);
    w.api.advance(attempt.transferId!, "SENT");
    w.api.advance(attempt.transferId!, "PAID");
    await w.gateway.sync(w.obligation.id);
    const [conversion] = w.ledger.conversionsFor(w.obligation.id);
    return { w, conversion: conversion! };
  }

  it("certifies version 3 with the conversion's legs as planned and as booked", async () => {
    const { w, conversion } = await fundedAndPaid();

    const certificate = await w.closer.close(w.obligation.id);

    expect(certificate.body.version).toBe(3);
    expect(certificate.body.funding).toEqual([
      expect.objectContaining({
        conversionId: conversion.conversionId, state: "SETTLED", currencyPair: "EURUSD", buyCurrency: "EUR", sellCurrency: "USD",
        expected: { buyMinor: SHORTFALL_MINOR, sellMinor: -SELL_MINOR }, actual: { buyMinor: SHORTFALL_MINOR, sellMinor: -SELL_MINOR },
      }),
    ]);
    expect(certificate.body.totals.paidMinor).toBe(w.obligation.amountMinor);
  });

  it("refuses to certify when Airwallex booked a stray line against the conversion, or a leg that does not tie", async () => {
    const stray = await fundedAndPaid();
    stray.w.api.line(stray.conversion.conversionId!, "CONVERSION", "FEE", "USD", -1);
    await expect(stray.w.closer.close(stray.w.obligation.id)).rejects.toMatchObject({ blockers: [expect.stringContaining("unexpected wallet line FEE")] });

    const short = await fundedAndPaid();
    const buy = short.w.api.wallet.get(short.conversion.conversionId!)!.find((l) => l.transaction_type === "CONVERSION_BUY")!;
    buy.net -= 0.01;
    const refused = await short.w.closer.close(short.w.obligation.id).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(NotClosable);
    expect(refused).toMatchObject({ blockers: expect.arrayContaining([expect.stringContaining(`bought ${SHORTFALL_MINOR - 1} minor EUR`)]) });
  });

  it("refuses to certify while the conversion has not settled, even after a person paid the replacement anyway", async () => {
    const w = await fundWorld();
    w.api.conversionStatus = "SCHEDULED";
    const { result } = await w.commander.fundAutomatically(w.obligation.id);
    expect(result.conversion.state).toBe("BOOKED");
    const { evidenceHash } = await w.commander.assess(w.obligation.id);
    const { attempt } = await w.gateway.submit(await w.commander.humanApproval({ obligationId: w.obligation.id, approver: OPS, note: NOTE, evidenceHash }));
    w.api.advance(attempt.transferId!, "SENT");
    w.api.advance(attempt.transferId!, "PAID");
    await w.gateway.sync(w.obligation.id);

    const refused = await w.closer.close(w.obligation.id).catch((e: unknown) => e);

    expect(refused).toBeInstanceOf(NotClosable);
    expect(refused).toMatchObject({ blockers: expect.arrayContaining([expect.stringContaining("still BOOKED; the conversion has not settled")]) });
  });
});
