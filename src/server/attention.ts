/**
 * Two things the board needs per incident, both derived from the ledger alone so they can be recomputed from the chain:
 * what an agent last did there, and why a person is needed. Neither is stored anywhere else.
 */
import { z } from "zod";
import { AgentWakeSchema, IncidentReactionSchema } from "../ledger/events";
import { pendingDraft } from "../commander/drafts";
import type { Attempt, LedgerEvent, Obligation } from "../ledger/ledger";
import type { IncidentSummary } from "./wire";

const ToolCallSchema = z.object({ actor: z.string(), tool: z.string(), outcome: z.string() });

/** The calls that decide something about an incident. Reading and assessing are not verdicts. */
const VERDICT_TOOLS: Record<string, true> = {
  replace_payment: true,
  escalate_to_human: true,
  defer_incident: true,
  draft_supplier_reply: true,
  reconcile_and_close: true,
};

/** The agent's most recent verdict on the incident, refused or not, so a hostile agent's attempts show on the board too. */
export function lastAgentAction(events: LedgerEvent[]): IncidentSummary["lastAgentAction"] {
  for (const event of events.toReversed()) {
    if (event.type !== "AGENT_TOOL_CALL") continue;
    const call = ToolCallSchema.safeParse(event.payload);
    if (call.success && Object.hasOwn(VERDICT_TOOLS, call.data.tool)) {
      return { actor: call.data.actor, tool: call.data.tool, outcome: call.data.outcome, at: event.ts };
    }
  }
  return null;
}

/** Why a person is needed, most urgent reason first; null when nothing is waiting for one. */
export function attentionOf(obligation: Obligation, latest: Attempt | undefined, events: LedgerEvent[]): IncidentSummary["attention"] {
  if (obligation.status === "ESCALATED") {
    return { kind: "ESCALATED", reason: obligation.escalationReason ?? "Handed to a person." };
  }
  if (obligation.status === "NEEDS_ACTION" && latest) {
    const code = latest.failureCode ? ` with failure ${latest.failureCode}` : "";
    return { kind: "NEEDS_ACTION", reason: `Attempt ${latest.seq} was cancelled${code}. The money is back; a replacement needs a decision.` };
  }
  if (obligation.status !== "CLOSED" && pendingDraft(events)) {
    return { kind: "DRAFT", reason: "A drafted reply to the supplier is waiting for a person to send it." };
  }
  return null;
}

/** The incident's latest reaction to a bank-side change and the wake that followed it, from the ledger alone. */
export function lastReaction(events: LedgerEvent[]): IncidentSummary["lastReaction"] {
  const at = events.findLastIndex((e) => e.type === "INCIDENT_REACTION");
  if (at < 0) return null;
  const event = events[at]!;
  const p = IncidentReactionSchema.safeParse(event.payload);
  if (!p.success) return null;
  const wake = events.slice(at + 1).find((e) => {
    if (e.type !== "AGENT_WAKE") return false;
    return AgentWakeSchema.safeParse(e.payload).data?.reactionSeqs.includes(event.seq) ?? false;
  });
  return {
    source: p.data.trigger.source,
    eventName: p.data.trigger.eventName,
    eventId: p.data.trigger.eventId,
    at: event.ts,
    to: p.data.changes.at(-1)!.to,
    before: p.data.before.recommended,
    after: p.data.after.recommended,
    decisionChanged: p.data.decisionChanged,
    wake: p.data.wake,
    woke: wake ? (AgentWakeSchema.safeParse(wake.payload).data?.outcome ?? null) : null,
  };
}
