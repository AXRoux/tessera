/** "What the agent did": one row per incident the run touched, plus a one-line headline. Pure over the streamed steps. */
import { toolLabel } from "./agent-verdict";

/** The streamed steps the console keeps (the same shape as the agent run's `Step`; declared here so this file stays free of React). */
export type Step =
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      id: string;
      tool: string;
      incident: string | null;
      detail: string | null;
      result: { ok: boolean; kind: "refused" | "invalid" | "failed" | null; summary: string } | null;
    };

type ToolStep = Extract<Step, { kind: "tool" }>;

export interface Chip {
  label: string;
  count: number;
  /** The code refused or turned this call away. */
  refused: boolean;
}

export interface RunRow {
  /** The incident's reference, as the server named it in the stream. The caller maps it to an id for the link. */
  reference: string;
  chips: Chip[];
}

export interface RunSummary {
  headline: string;
  rows: RunRow[];
}

/** Calls that only look. In an adversary run these are not "moves". */
const READ_ONLY = new Set(["list_incidents", "assess_incident", "read_supplier_message", "verify_ledger"]);

const DONE_LABEL: Record<string, string> = {
  assess_incident: "Assessed",
  read_supplier_message: "Read mail",
  replace_payment: "Replaced",
  escalate_to_human: "Escalated",
  draft_supplier_reply: "Drafted",
  defer_incident: "Deferred",
  reconcile_and_close: "Certified",
};

/** Chip for one finished call. */
function chipFor(tool: string, result: NonNullable<ToolStep["result"]>): { label: string; refused: boolean } {
  if (result.ok) return { label: DONE_LABEL[tool] ?? toolLabel(tool), refused: false };
  if (result.kind === "failed") return { label: "Failed", refused: false };
  return { label: "Refused", refused: true };
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * Only calls the server has answered count: a call still waiting for its result has done nothing yet. Chips keep the
 * order in which each kind first happened; repeats of the same kind merge into one chip with a count.
 */
export function summarizeRun(steps: Step[], mode: "commander" | "adversary" = "commander"): RunSummary {
  const answered = steps.filter((s): s is ToolStep & { result: NonNullable<ToolStep["result"]> } => s.kind === "tool" && s.result !== null);

  const rows = new Map<string, RunRow>();
  for (const step of answered) {
    if (!step.incident) continue;
    const row = rows.get(step.incident) ?? { reference: step.incident, chips: [] };
    rows.set(step.incident, row);
    const { label, refused } = chipFor(step.tool, step.result);
    const chip = row.chips.find((c) => c.label === label);
    if (chip) chip.count += 1;
    else row.chips.push({ label, count: 1, refused });
  }
  // "Assessed" is only there so a row exists for an incident the agent merely looked at; it is noise next to a real action.
  for (const row of rows.values()) {
    if (row.chips.length > 1) row.chips = row.chips.filter((c) => c.label !== "Assessed");
  }

  if (mode === "adversary") {
    const moves = answered.filter((s) => !READ_ONLY.has(s.tool));
    const stopped = moves.filter((s) => !s.result.ok && s.result.kind !== "failed").length;
    const through = moves.filter((s) => s.result.ok).length;
    const headline =
      moves.length === 0
        ? "The adversary made no moves."
        : `Tried ${plural(moves.length, "move")}; code stopped ${stopped}${through > 0 ? `; ${through} went through` : ""}.`;
    return { headline, rows: [...rows.values()] };
  }

  const count = (tool: string): number => answered.filter((s) => s.tool === tool && s.result.ok).length;
  const refused = answered.filter((s) => !s.result.ok && s.result.kind !== "failed").length;
  const parts = [
    [count("replace_payment"), "replaced"],
    [count("escalate_to_human"), "handed to you"],
    [count("draft_supplier_reply"), "drafted"],
    [count("defer_incident"), "deferred"],
    [count("reconcile_and_close"), "certified"],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, text]) => `${n} ${text}`);
  parts.push(`${refused} refused`);
  const headline = rows.size === 0 ? `Worked no incidents: ${refused} refused.` : `Worked ${plural(rows.size, "incident")}: ${parts.join(", ")}`;
  return { headline, rows: [...rows.values()] };
}
