import { describe, expect, it } from "bun:test";
import { deriveTour, needsYou, viewNeedsPerson, type TourItem } from "../web/lib/tour-steps";

const item = (id: string, over: Partial<TourItem> = {}): TourItem => ({ id, reference: `INV-${id}`, lastAgentAction: null, attention: null, ...over });
const action = (actor: string) => ({ actor, tool: "defer_incident", outcome: "ok", at: "2026-01-01T00:00:00Z" });
const metrics = { agentRefusals: 0, certified: 0 };

describe("deriveTour", () => {
  it("starts at step 1 on an empty board", () => {
    const tour = deriveTour({ items: [], metrics, openedAttention: false });
    expect(tour.current).toBe("seed");
    expect(tour.doneCount).toBe(0);
    expect(tour.complete).toBe(false);
  });

  it("moves to step 2 when incidents exist but no agent has acted", () => {
    const tour = deriveTour({ items: [item("1"), item("2")], metrics, openedAttention: false });
    expect(tour.steps.find((s) => s.id === "seed")?.done).toBe(true);
    expect(tour.steps.find((s) => s.id === "agent")?.done).toBe(false);
    expect(tour.current).toBe("agent");
    expect(tour.doneCount).toBe(1);
  });

  it("does not count the adversary's attempts as the agent working the incidents", () => {
    const tour = deriveTour({ items: [item("1", { lastAgentAction: action("agent:adversary") })], metrics, openedAttention: false });
    expect(tour.steps.find((s) => s.id === "agent")?.done).toBe(false);
    const real = deriveTour({ items: [item("1", { lastAgentAction: action("agent:scripted") })], metrics, openedAttention: false });
    expect(real.steps.find((s) => s.id === "agent")?.done).toBe(true);
  });

  it("marks the adversary and certify steps from the metrics, and nothing from unreadable metrics", () => {
    const items = [item("1", { lastAgentAction: action("agent:claude") })];
    const done = (m: typeof metrics | null) => deriveTour({ items, metrics: m, openedAttention: false }).steps.filter((s) => s.done).map((s) => s.id);
    expect(done({ agentRefusals: 3, certified: 1 })).toEqual(["seed", "agent", "adversary", "certify"]);
    expect(done(null)).toEqual(["seed", "agent"]);
  });

  it("keeps the current step at the first unfinished one even when a later one is done", () => {
    const tour = deriveTour({ items: [item("1")], metrics: { agentRefusals: 0, certified: 2 }, openedAttention: false });
    expect(tour.current).toBe("agent");
    expect(tour.steps.find((s) => s.id === "certify")?.done).toBe(true);
  });

  it("points step 4 at the most urgent incident waiting for a person, and is done once the operator opened one", () => {
    const items = [
      item("draft", { attention: { kind: "DRAFT", reason: "reply waiting" } }),
      item("esc", { attention: { kind: "ESCALATED", reason: "possible duplicate" } }),
    ];
    const tour = deriveTour({ items, metrics, openedAttention: false });
    expect(tour.takeover).toEqual({ id: "esc", reference: "INV-esc", reason: "possible duplicate" });
    expect(tour.steps.find((s) => s.id === "takeover")?.done).toBe(false);
    expect(deriveTour({ items, metrics, openedAttention: true }).steps.find((s) => s.id === "takeover")?.done).toBe(true);
  });

  it("has no takeover target when nothing is waiting, and completes only when all five are done", () => {
    expect(deriveTour({ items: [item("1")], metrics, openedAttention: false }).takeover).toBeNull();
    const all = deriveTour({
      items: [item("1", { lastAgentAction: action("agent:claude") })],
      metrics: { agentRefusals: 1, certified: 1 },
      openedAttention: true,
    });
    expect(all.complete).toBe(true);
    expect(all.current).toBeNull();
    expect(all.doneCount).toBe(5);
  });
});

describe("needsYou", () => {
  it("orders escalated, then needs-a-decision, then drafts, newest first within each, and skips the rest", () => {
    // Input is the board's order: newest first.
    const items = [
      item("d1", { attention: { kind: "DRAFT", reason: "" } }),
      item("none"),
      item("n1", { attention: { kind: "NEEDS_ACTION", reason: "" } }),
      item("e1", { attention: { kind: "ESCALATED", reason: "" } }),
      item("e2", { attention: { kind: "ESCALATED", reason: "" } }),
      item("n2", { attention: { kind: "NEEDS_ACTION", reason: "" } }),
    ];
    expect(needsYou(items).map((i) => i.id)).toEqual(["e1", "e2", "n1", "n2", "d1"]);
  });
});

describe("viewNeedsPerson", () => {
  it("matches the server's attention rules from the incident page's data", () => {
    expect(viewNeedsPerson({ obligation: { status: "ESCALATED" }, draft: null })).toBe(true);
    expect(viewNeedsPerson({ obligation: { status: "NEEDS_ACTION" }, draft: null })).toBe(true);
    expect(viewNeedsPerson({ obligation: { status: "PAYING" }, draft: {} })).toBe(true);
    expect(viewNeedsPerson({ obligation: { status: "CLOSED" }, draft: {} })).toBe(false);
    expect(viewNeedsPerson({ obligation: { status: "PAID" }, draft: null })).toBe(false);
  });
});

describe("deriveTour, agent step after an adversary run", () => {
  const overwritten = [item("1", { lastAgentAction: action("agent:adversary") })];
  it("stays done once the agent was seen working, even though the adversary overwrote every verdict", () => {
    expect(deriveTour({ items: overwritten, metrics, openedAttention: false, agentSeen: true }).steps.find((s) => s.id === "agent")?.done).toBe(true);
  });
  it("ignores a remembered sighting when the board is empty (a fresh server)", () => {
    const tour = deriveTour({ items: [], metrics, openedAttention: false, agentSeen: true });
    expect(tour.steps.find((s) => s.id === "agent")?.done).toBe(false);
    expect(tour.current).toBe("seed");
  });
});
