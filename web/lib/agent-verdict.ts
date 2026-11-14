/** What the board says about an agent's latest verdict on an incident, in plain English. Pure, so it can be tested. */

export interface VerdictInput {
  actor: string;
  tool: string;
  outcome: string;
}

export interface Verdict {
  /** "Replaced it", "Tried to close, refused by policy". */
  label: string;
  /** Policy said no. Rendered in the loud black style the agent timeline uses for refusals. */
  refused: boolean;
}

/** "replace_payment" as "Replace payment". */
export function toolLabel(tool: string): string {
  const words = tool.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const OK: Record<string, string> = {
  replace_payment: "Replaced it",
  fund_replacement: "Funded the replacement",
  escalate_to_human: "Handed to you",
  defer_incident: "Deferred",
  draft_supplier_reply: "Drafted a reply",
  reconcile_and_close: "Certified it",
};

const REFUSED: Record<string, string> = {
  replace_payment: "Tried to replace, refused by policy",
  fund_replacement: "Tried to convert, refused by policy",
  reconcile_and_close: "Tried to close, refused by policy",
};

export function agentVerdict({ tool, outcome }: Pick<VerdictInput, "tool" | "outcome">): Verdict {
  if (outcome === "ok") return { label: OK[tool] ?? toolLabel(tool), refused: false };
  if (outcome === "failed") return { label: `${toolLabel(tool)} failed`, refused: false };
  // "refused" and "invalid" both mean policy turned the call away; anything unrecognised is treated the same way.
  return { label: REFUSED[tool] ?? `${toolLabel(tool)} refused`, refused: true };
}

/** "agent:claude" as "Claude", "agent:scripted" as "Scripted agent", "agent:hermes-4-405b" as "Hermes 4 405b". */
export function actorLabel(actor: string): string {
  const name = actor.startsWith("agent:") ? actor.slice("agent:".length) : actor;
  if (name === "scripted") return "Scripted agent";
  if (name === "claude") return "Claude";
  const words = name.split(/[-_\s]+/).filter(Boolean);
  if (words.length === 0) return "Agent";
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** Escalation reasons are stored as "agent:scripted: <reason>". Next to a "handed over by" line the prefix is noise; the full text stays in the tooltip. */
export function reasonText(reason: string): string {
  return reason.replace(/^agent:[\w-]+:\s*/, "");
}
