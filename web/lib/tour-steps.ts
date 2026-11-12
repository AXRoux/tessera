/**
 * The "Start here" walkthrough, derived from what the board shows (incidents and metrics) rather than from clicks, so
 * a reload, or a second browser, lands on the same step. Pure, so every edge case is testable.
 */
import type { Health, IncidentSummary, Metrics } from "../../src/server/wire";

export type TourStepId = "seed" | "agent" | "adversary" | "takeover" | "certify";

export type TourItem = Pick<IncidentSummary, "id" | "reference" | "lastAgentAction" | "attention">;

export interface TourInput {
  items: TourItem[];
  /** Null while the numbers cannot be read: nothing that needs them counts as done. */
  metrics: Pick<Metrics, "agentRefusals" | "certified"> | null;
  /** The operator has opened an incident that was waiting for a person. Remembered by the browser. */
  openedAttention: boolean;
  /**
   * The agent was seen working the board earlier. Each incident keeps only the agent's latest verdict, so an adversary
   * run overwrites the evidence on every row; the browser remembers that step 2 was done.
   */
  agentSeen?: boolean;
}

export interface TourState {
  steps: { id: TourStepId; title: string; done: boolean }[];
  doneCount: number;
  total: number;
  /** The first step not done; null once all five are. */
  current: TourStepId | null;
  complete: boolean;
  /** The first incident waiting for a person, for step 4. The board lists the most urgent first, so this is the first in the list. */
  takeover: { id: string; reference: string; reason: string } | null;
}

export const TOUR_TITLES: Record<TourStepId, string> = {
  seed: "Load the incidents",
  agent: "Watch it work",
  adversary: "Try to break it",
  takeover: "Take over",
  certify: "Get one certified",
};

const ORDER: TourStepId[] = ["seed", "agent", "adversary", "takeover", "certify"];

/** Incident-page mirror of the server's `attention`: a person is needed when it is escalated, needs a decision, or has an unsent draft. */
export function viewNeedsPerson(view: { obligation: { status: string }; draft: unknown }): boolean {
  const { status } = view.obligation;
  return status === "ESCALATED" || status === "NEEDS_ACTION" || (status !== "CLOSED" && view.draft !== null);
}

/** Attention kinds, most urgent first. Shared by the "Needs you" queue and the tour. */
const URGENCY = { ESCALATED: 0, NEEDS_ACTION: 1, DRAFT: 2 } as const;

/** Incidents waiting for a person: most urgent kind first, newest first within a kind. Input order is the board's (newest first). */
export function needsYou<T extends { attention: IncidentSummary["attention"] }>(items: T[]): (T & { attention: NonNullable<IncidentSummary["attention"]> })[] {
  const waiting = items.flatMap((item, index) => (item.attention ? [{ item: item as T & { attention: NonNullable<IncidentSummary["attention"]> }, index }] : []));
  waiting.sort((a, b) => URGENCY[a.item.attention.kind] - URGENCY[b.item.attention.kind] || a.index - b.index);
  return waiting.map((w) => w.item);
}

/** True while some incident's latest agent verdict is from an agent working it (not the adversary). */
export function agentWorked(items: Pick<TourItem, "lastAgentAction">[]): boolean {
  return items.some((i) => i.lastAgentAction !== null && i.lastAgentAction.actor !== "agent:adversary");
}

export function deriveTour({ items, metrics, openedAttention, agentSeen = false }: TourInput): TourState {
  const done: Record<TourStepId, boolean> = {
    seed: items.length > 0,
    // The adversary's refusals are not the agent doing the work; only a non-adversary verdict counts.
    agent: (agentSeen && items.length > 0) || agentWorked(items),
    adversary: metrics !== null && metrics.agentRefusals > 0,
    takeover: openedAttention,
    certify: metrics !== null && metrics.certified > 0,
  };
  const steps = ORDER.map((id) => ({ id, title: TOUR_TITLES[id], done: done[id] }));
  const doneCount = steps.filter((s) => s.done).length;
  const first = needsYou(items)[0];
  return {
    steps,
    doneCount,
    total: steps.length,
    current: steps.find((s) => !s.done)?.id ?? null,
    complete: doneCount === steps.length,
    takeover: first ? { id: first.id, reference: first.reference, reason: first.attention.reason } : null,
  };
}

/** Who is meant by "the agent" in tour copy: the model's name only when a model is what runs. */
export function tourAgent(agent: Health["agent"] | undefined): { name: string; Name: string } {
  if (agent?.kind === "model") return { name: agent.name, Name: agent.name };
  if (agent?.kind === "scripted") return { name: "the scripted agent (not a model)", Name: "The scripted agent (not a model)" };
  return { name: "the agent", Name: "The agent" };
}
