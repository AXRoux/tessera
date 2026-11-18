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

/**
 * Who acted, as the console names them. Tessera is agent-agnostic, so whichever model drives the agent it is simply
 * "Agent" (the model is metadata on the Keys page, never a name in the record). The deterministic scripted agent and
 * the guardrail test's adversary keep their names, because those say what they are. A person is shown as given.
 */
export function actorLabel(actor: string): string {
  if (!actor.startsWith("agent:")) return actor;
  const name = actor.slice("agent:".length);
  if (name === "scripted") return "Scripted agent";
  if (name === "adversary") return "Adversary";
  return "Agent";
}

/** The same, at the start of a sentence: "The agent handed it over", "The scripted agent", "The adversary". */
export function actorSubject(actor: string): string {
  if (!actor.startsWith("agent:")) return actor;
  const label = actorLabel(actor);
  return `The ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}

/** Escalation reasons are stored as "agent:scripted: <reason>". Next to a "handed over by" line the prefix is noise; the full text stays in the tooltip. */
export function reasonText(reason: string): string {
  return reason.replace(/^agent:[\w-]+:\s*/, "");
}
