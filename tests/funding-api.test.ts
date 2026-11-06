import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { createApi } from "../src/server/api";
import { FundingQuoteSchema, FundingResultSchema, IncidentViewSchema, ProblemSchema, WalletsSchema } from "../src/server/wire";
import { fundWorld, SELL_MINOR, SHORTFALL_MINOR, type FundWorld, type FundWorldOptions } from "./helpers/fund-world";

const TOKEN = "operator-token-for-funding-tests";
const OPS = "ops@acme.example";
const NOTE = "checked the rate with treasury before converting";

async function fundApi(options: FundWorldOptions = {}) {
  const w = await fundWorld(options);
  const handle = createApi({
    ledger: w.ledger, gateway: w.gateway, commander: w.commander, closer: w.closer, model: null, simulator: null, token: TOKEN,
    operator: OPS, beneficiaryId: "ben-A", paidHoldMs: 0,
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await handle(
      new Request(`http://api.test${path}`, {
        method, headers: { "content-type": "application/json", "x-tessera-token": TOKEN }, body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    return { status: response.status, json: (await response.json()) as unknown };
  };
  return { w, call };
}

const RefusalSchema = z.object({ route: z.string() });
const refusals = (w: FundWorld) => w.ledger.events(w.obligation.id).filter((e) => e.type === "PAYMENT_REFUSED").map((e) => RefusalSchema.parse(e.payload).route);

describe("GET /api/wallets", () => {
  it("shows each wallet next to the floor it keeps and whether it may fund", async () => {
    const { call } = await fundApi();

    const wallets = WalletsSchema.parse((await call("GET", "/api/wallets")).json);

    expect(wallets.readable).toBe(true);
    expect(wallets.wallets.find((x) => x.currency === "EUR")).toEqual({ currency: "EUR", availableMinor: 101_167, floorMinor: 100_000, fundingSource: true });
    expect(wallets.fundingSources).toEqual(["USD", "GBP", "EUR"]);
  });

  it("says when the balances cannot be read, rather than showing zeros", async () => {
    const { w, call } = await fundApi();
    w.api.faults.failBalances = 1;

    expect(WalletsSchema.parse((await call("GET", "/api/wallets")).json)).toMatchObject({ readable: false, wallets: [] });
  });
});

describe("POST /api/obligations/:id/fund", () => {
  it("books the plan's conversion, shows it on the incident, and refuses a second one on the record", async () => {
    const { w, call } = await fundApi();

    const funded = await call("POST", `/api/obligations/${w.obligation.id}/fund`);
    const again = await call("POST", `/api/obligations/${w.obligation.id}/fund`);

    expect(funded.status).toBe(201);
    expect(FundingResultSchema.parse(funded.json).conversion).toMatchObject({ state: "SETTLED", buyMinor: SHORTFALL_MINOR, sellMinor: SELL_MINOR });
    expect(again.status).toBe(409);
    expect(ProblemSchema.parse(again.json).reasons?.length).toBeGreaterThan(0);
    expect(refusals(w)).toEqual(["fund"]);
    const view = IncidentViewSchema.parse((await call("GET", `/api/obligations/${w.obligation.id}`)).json);
    expect(view.conversions.map((c) => c.state)).toEqual(["SETTLED"]);
    expect(view.assessment?.decision.recommended).toBe("REPLACE");
  });
});

describe("a person's funding approval, in two steps", () => {
  it("quotes for review, then books only the quote echoed back with its fingerprint", async () => {
    const { w, call } = await fundApi({ policy: { autoConvertLimitMinor: {} } });
    const view = IncidentViewSchema.parse((await call("GET", `/api/obligations/${w.obligation.id}`)).json);
    expect(view.assessment?.decision.funding).toMatchObject({ buyMinor: SHORTFALL_MINOR, autoApprovable: false });
    expect((await call("POST", `/api/obligations/${w.obligation.id}/fund`)).status).toBe(409);

    const quote = FundingQuoteSchema.parse((await call("POST", `/api/obligations/${w.obligation.id}/fund/quote`)).json);
    const approve = (overrides: Record<string, unknown> = {}) =>
      call("POST", `/api/obligations/${w.obligation.id}/fund/approve`, { note: NOTE, evidenceHash: quote.evidenceHash, quoteId: quote.quoteId, fingerprint: quote.fingerprint, ...overrides });

    const wrongPrint = await approve({ fingerprint: "0".repeat(64) });
    const noNote = await approve({ note: "ok" });
    const smuggled = await approve({ buyMinor: 1 });
    const booked = await approve();

    expect(wrongPrint.status).toBe(409);
    expect(ProblemSchema.parse(wrongPrint.json).code).toBe("stale");
    expect(noNote.status).toBe(400);
    expect(smuggled.status).toBe(201);
    expect(FundingResultSchema.parse(smuggled.json).conversion).toMatchObject({ quoteId: quote.quoteId, buyMinor: quote.buyMinor });
    expect(booked.status).toBe(409);
    expect(w.api.conversions.size).toBe(1);
  });
});
