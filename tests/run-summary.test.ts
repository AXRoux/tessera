import { describe, expect, it } from "bun:test";
import { summarizeRun, type Step } from "../web/lib/run-summary";

let n = 0;
const call = (tool: string, incident: string | null, result: { ok: true } | { ok: false; kind: "refused" | "invalid" | "failed" } | null): Step => ({
  kind: "tool",
  id: `c${n++}`,
  tool,
  incident,
  detail: null,
  result: result === null ? null : { ok: result.ok, kind: result.ok ? null : result.kind, summary: "" },
});
const ok = { ok: true } as const;
const refused = { ok: false, kind: "refused" } as const;

describe("summarizeRun, commander", () => {
  it("makes one row per incident with chips in the order things happened", () => {
    const { rows, headline } = summarizeRun([
      call("list_incidents", null, ok),
      call("read_supplier_message", "INV-1", ok),
      call("replace_payment", "INV-1", ok),
      call("escalate_to_human", "INV-2", ok),
      call("draft_supplier_reply", "INV-3", ok),
      call("reconcile_and_close", "INV-4", ok),
    ]);
    expect(rows.map((r) => r.reference)).toEqual(["INV-1", "INV-2", "INV-3", "INV-4"]);
    expect(rows[0]?.chips.map((c) => c.label)).toEqual(["Read mail", "Replaced"]);
    expect(rows[1]?.chips.map((c) => c.label)).toEqual(["Escalated"]);
    expect(headline).toBe("Worked 4 incidents: 1 replaced, 1 handed to you, 1 drafted, 1 certified, 0 refused");
  });

  it("shows an incident the agent only assessed, but drops that chip once something real happened there", () => {
    const { rows } = summarizeRun([call("assess_incident", "INV-1", ok), call("assess_incident", "INV-2", ok), call("defer_incident", "INV-2", ok)]);
    expect(rows.map((r) => r.chips.map((c) => c.label))).toEqual([["Assessed"], ["Deferred"]]);
  });

  it("counts refusals and merges repeats into one counted chip", () => {
    const { rows, headline } = summarizeRun([
      call("replace_payment", "INV-1", refused),
      call("replace_payment", "INV-1", refused),
      call("escalate_to_human", "INV-1", ok),
    ]);
    expect(rows[0]?.chips).toEqual([
      { label: "Refused", count: 2, refused: true },
      { label: "Escalated", count: 1, refused: false },
    ]);
    expect(headline).toBe("Worked 1 incident: 1 handed to you, 2 refused");
  });

  it("does not count a call that is still waiting for its answer, or a failure, as a refusal", () => {
    const { rows, headline } = summarizeRun([call("replace_payment", "INV-1", null), call("reconcile_and_close", "INV-2", { ok: false, kind: "failed" })]);
    expect(rows.map((r) => r.reference)).toEqual(["INV-2"]);
    expect(rows[0]?.chips).toEqual([{ label: "Failed", count: 1, refused: false }]);
    expect(headline).toBe("Worked 1 incident: 0 refused");
  });

  it("says plainly when nothing was touched", () => {
    expect(summarizeRun([{ kind: "text", text: "Nothing to do." }])).toEqual({ headline: "Worked no incidents: 0 refused.", rows: [] });
  });
});

describe("summarizeRun, adversary", () => {
  it("reports every move the code stopped and does not count reads as moves", () => {
    const steps = [
      call("list_incidents", null, ok),
      call("read_supplier_message", "INV-1", ok),
      ...Array.from({ length: 19 }, (_, i) => call("replace_payment", `INV-${(i % 3) + 1}`, i % 2 ? refused : { ok: false, kind: "invalid" as const })),
    ];
    const { headline, rows } = summarizeRun(steps, "adversary");
    expect(headline).toBe("Tried 19 moves; code stopped 19.");
    expect(rows.find((r) => r.reference === "INV-1")?.chips.some((c) => c.refused)).toBe(true);
  });

  it("is honest when a move got through", () => {
    const { headline } = summarizeRun([call("replace_payment", "INV-1", refused), call("defer_incident", "INV-1", ok)], "adversary");
    expect(headline).toBe("Tried 2 moves; code stopped 1; 1 went through.");
  });

  it("handles a run with no moves", () => {
    expect(summarizeRun([], "adversary").headline).toBe("The adversary made no moves.");
  });
});
