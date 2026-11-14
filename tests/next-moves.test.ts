import { describe, expect, it } from "bun:test";
import type { IncidentSummary } from "../src/server/wire";
import { agentPlan, boardMoves, leftBecause, moveOf } from "../web/lib/next-moves";

let n = 0;
function invoice(over: Partial<IncidentSummary> = {}): IncidentSummary {
  n += 1;
  return {
    id: `id-${n}`, reference: `INV-00${n}`, amountMinor: 2_500, currency: "USD", method: "LOCAL", status: "PAYING", attemptCount: 1,
    latest: { seq: 1, state: "LIVE", awxStatus: "SENT", failureCode: null }, updatedAt: "2026-11-13T00:00:00Z",
    lastAgentAction: null, attention: null, lastReaction: null, next: { action: "WAIT", allowed: ["WAIT"], recheckAt: "2026-11-13T00:05:00Z" }, unread: 0,
    ...over,
  };
}

describe("the next move on each invoice", () => {
  it("names who makes it: a person for an escalation, the agent for a certifiable payment, nobody for one with the bank", () => {
    expect(moveOf(invoice({ attention: { kind: "ESCALATED", reason: "agent:claude: supplier changed banks by email." } }))).toMatchObject({
      who: "you", label: "Decide", agentCan: false, line: "Handed to you: supplier changed banks by email.",
    });
    const paid = invoice({ status: "PAID", latest: { seq: 1, state: "PAID", awxStatus: "PAID", failureCode: null }, next: { action: "CLOSE", allowed: ["CLOSE"], recheckAt: null } });
    expect(moveOf(paid)).toMatchObject({ who: "agent", label: "Certify", agentCan: true });
    expect(moveOf(invoice())).toMatchObject({ who: "bank", label: "With the bank", agentCan: false });
    expect(moveOf(invoice({ status: "CLOSED" }))).toMatchObject({ who: "done", label: "Certified" });
  });

  it("lets the agent work a failed payment it may replace automatically, while it stays in your queue", () => {
    const failed = { attention: { kind: "NEEDS_ACTION" as const, reason: "Attempt 1 was cancelled with failure 91203." } };
    expect(moveOf(invoice({ ...failed, next: { action: "REPLACE", allowed: ["REPLACE"], recheckAt: null, autoReplace: true } }))).toMatchObject({ who: "you", agentCan: true, label: "Replace" });
    expect(moveOf(invoice({ ...failed, next: { action: "REPLACE", allowed: ["REPLACE"], recheckAt: null, autoReplace: false } }))).toMatchObject({ who: "you", agentCan: false, label: "Decide" });
  });

  it("puts an unread supplier message before certifying, and gives it to a person when nothing can read it", () => {
    const paid = invoice({ unread: 1, next: { action: "CLOSE", allowed: ["CLOSE"], recheckAt: null } });
    expect(moveOf(paid)).toMatchObject({ who: "agent", label: "Read message" });
    expect(moveOf(paid, { reader: false })).toMatchObject({ who: "you", label: "Read message", agentCan: false });
  });

  it("orders the board's moves by urgency and leaves out what only needs the bank", () => {
    const certify = invoice({ next: { action: "CLOSE", allowed: ["CLOSE"], recheckAt: null } });
    const replace = invoice({ next: { action: "REPLACE", allowed: ["REPLACE"], recheckAt: null } });
    const decide = invoice({ attention: { kind: "NEEDS_ACTION", reason: "duplicate return" } });
    const waiting = invoice();
    expect(boardMoves([certify, waiting, replace, decide]).map((m) => m.item.id)).toEqual([decide.id, replace.id, certify.id]);
  });

  it("says before a run which invoices the agent will work and why it leaves the others", () => {
    const certify = invoice({ next: { action: "CLOSE", allowed: ["CLOSE"], recheckAt: null } });
    const decide = invoice({ attention: { kind: "ESCALATED", reason: "phishing" } });
    const waiting = invoice();
    const plan = agentPlan([certify, decide, waiting, invoice({ status: "CLOSED" })]);
    expect(plan.work.map((m) => m.item.id)).toEqual([certify.id]);
    expect(plan.leave.map((m) => [m.item.id, leftBecause(m)])).toEqual([
      [decide.id, "yours to decide"],
      [waiting.id, "with the bank"],
    ]);
    expect(plan.certified).toBe(1);
  });
});
