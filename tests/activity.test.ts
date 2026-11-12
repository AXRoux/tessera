import { describe, expect, it } from "bun:test";
import { activity, bandOf, clockLabel, exposure, heldBackLine, windowFor } from "../web/lib/activity";
import type { IncidentSummary, IncidentView, Metrics } from "../src/server/wire";

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 12, minute, 0)).toISOString();
const NOW = Date.parse(at(30));

/** Only the three fields the chart reads are real; the rest of the view is noise the chart must ignore. */
const view = (events: { type: string; ts: string }[]): IncidentView =>
  ({ events: events.map((event, seq) => ({ ...event, seq, prevHash: "p", hash: "h", obligationId: null, payload: null })) }) as unknown as IncidentView;

const item = (id: string, over: Partial<IncidentSummary> = {}): IncidentSummary =>
  ({
    id,
    reference: `ACME-${id}`,
    amountMinor: 2500,
    currency: "USD",
    method: "LOCAL",
    status: "OPEN",
    attemptCount: 0,
    latest: null,
    updatedAt: at(0),
    lastAgentAction: null,
    attention: null,
    lastReaction: null,
    ...over,
  }) as IncidentSummary;

describe("bandOf", () => {
  it("sorts the real ledger types into bands", () => {
    expect(bandOf("ATTEMPT_INTENT")).toBe("moved");
    expect(bandOf("PAYMENT_REFUSED")).toBe("held");
    expect(bandOf("ESCALATED")).toBe("person");
    expect(bandOf("CLOSED")).toBe("proof");
    expect(bandOf("AGENT_TOOL_CALL")).toBe("agent");
  });

  it("counts an event type it has never seen as agent work rather than dropping it", () => {
    expect(bandOf("SOMETHING_NEW")).toBe("agent");
  });
});

describe("activity", () => {
  const window = { now: NOW, tickMs: 60_000, ticks: 6 };

  it("buckets events by band, oldest bucket first", () => {
    const result = activity([view([{ type: "ATTEMPT_INTENT", ts: at(25) }, { type: "PAYMENT_REFUSED", ts: at(25) }, { type: "CLOSED", ts: at(29) }])], window);
    expect(result.ticks).toHaveLength(6);
    expect(result.ticks[1]!.counts.moved).toBe(1);
    expect(result.ticks[1]!.counts.held).toBe(1);
    expect(result.ticks[5]!.counts.proof).toBe(1);
    expect(result.total).toBe(3);
    expect(result.max).toBe(2);
    expect(result.empty).toBe(false);
  });

  it("keeps an event landing exactly on the start and on now", () => {
    const result = activity([view([{ type: "CLOSED", ts: at(24) }, { type: "CLOSED", ts: at(30) }])], window);
    expect(result.total).toBe(2);
    expect(result.ticks[0]!.counts.proof).toBe(1);
    expect(result.ticks[5]!.counts.proof).toBe(1);
  });

  it("drops events outside the window and unreadable timestamps", () => {
    const result = activity([view([{ type: "CLOSED", ts: at(23) }, { type: "CLOSED", ts: at(31) }, { type: "CLOSED", ts: "not-a-date" }])], window);
    expect(result.total).toBe(0);
    expect(result.empty).toBe(true);
    expect(result.max).toBe(1);
  });

  it("sums every incident's ledger", () => {
    const result = activity([view([{ type: "AGENT_TOOL_CALL", ts: at(29) }]), view([{ type: "AGENT_TOOL_CALL", ts: at(29) }])], window);
    expect(result.ticks[5]!.counts.agent).toBe(2);
  });
});

describe("windowFor", () => {
  it("picks minute buckets for a board that just moved", () => {
    expect(windowFor([view([{ type: "CLOSED", ts: at(29) }])], NOW).tickMs).toBe(60_000);
  });

  it("widens the bucket until the oldest event fits", () => {
    const threeHours = new Date(NOW - 3 * 3_600_000).toISOString();
    expect(windowFor([view([{ type: "CLOSED", ts: threeHours }])], NOW).tickMs).toBe(15 * 60_000);
  });

  it("uses the narrowest window when there is no history at all", () => {
    expect(windowFor([], NOW).tickMs).toBe(60_000);
  });
});

describe("exposure", () => {
  it("orders columns oldest first and totals per currency", () => {
    const result = exposure([
      item("1", { updatedAt: at(20), amountMinor: 1000 }),
      item("2", { updatedAt: at(5), amountMinor: 500, currency: "EUR" }),
      item("3", { updatedAt: at(10), amountMinor: 2500 }),
    ]);
    expect(result.columns.map((c) => c.id)).toEqual(["2", "3", "1"]);
    expect(result.maxMinor).toBe(2500);
    expect(result.totals).toEqual([
      { currency: "USD", minor: 3500, count: 2 },
      { currency: "EUR", minor: 500, count: 1 },
    ]);
  });

  it("counts what is waiting on a person and bands those columns as person work", () => {
    const result = exposure([
      item("1", { attention: { kind: "ESCALATED", reason: "agent:scripted: no" }, status: "ESCALATED" }),
      item("2", { status: "CLOSED" }),
    ]);
    expect(result.waiting).toBe(1);
    expect(result.columns.find((c) => c.id === "1")?.band).toBe("person");
    expect(result.columns.find((c) => c.id === "1")?.note).toBe("Handed to a person");
    expect(result.columns.find((c) => c.id === "2")?.band).toBe("proof");
  });

  it("keeps an empty board from dividing by zero", () => {
    const result = exposure([]);
    expect(result.maxMinor).toBe(1);
    expect(result.totals).toEqual([]);
  });
});

describe("heldBackLine", () => {
  it("lists only currencies that actually held money back", () => {
    const metrics = { refusedAmountMinor: { USD: 2500, EUR: 0 }, paymentsRefused: 1 } as unknown as Metrics;
    expect(heldBackLine(metrics)).toBe("$25.00");
    expect(heldBackLine({ refusedAmountMinor: {}, paymentsRefused: 0 } as unknown as Metrics)).toBe("$0.00");
    expect(heldBackLine(null)).toBe("—");
  });
});

describe("clockLabel", () => {
  it("uses a clock for short buckets and a date for long ones", () => {
    expect(clockLabel(NOW)).toMatch(/^\d{2}:\d{2}$/);
    expect(clockLabel(NOW, 6 * 3_600_000)).toMatch(/[A-Za-z]{3}/);
  });
});
