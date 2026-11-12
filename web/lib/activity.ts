/**
 * What the ledger has been doing lately, as a chart, and what is on the board right now, as columns.
 *
 * Both are pure functions of what the API already answers (`/api/obligations` and one `/api/obligations/:id` per
 * incident), so the control panel shows real history without a route of its own, and every edge case is testable.
 */
import type { IncidentSummary, IncidentView, Metrics } from "../../src/server/wire";
import { money } from "./format";

/** The five things an operator watches for, and the colour each one is drawn in. */
export const BANDS = ["moved", "held", "person", "proof", "agent"] as const;
export type Band = (typeof BANDS)[number];

export const BAND_STYLE: Record<Band, { label: string; color: string }> = {
  moved: { label: "Money moved", color: "#5b8cff" },
  held: { label: "Stopped or failed", color: "#ff7a87" },
  person: { label: "Handed to a person", color: "#ffffff" },
  proof: { label: "Certified", color: "#7ee0a1" },
  agent: { label: "Agent and bank events", color: "#aab5ff" },
};

/**
 * Every ledger event type, sorted. An event whose type the chart has never heard of counts as agent work rather than
 * disappearing, so a new event type still shows up on the timeline.
 */
const BAND_OF: Record<string, Band> = {
  ATTEMPT_INTENT: "moved",
  ATTEMPT_RESOLVED: "moved",
  TRANSFER_STATUS: "moved",
  FUNDING_INTENT: "moved",
  FUNDING_QUOTED: "moved",
  FUNDING_BALANCES: "moved",
  FUNDING_STATUS: "moved",
  FUNDING_REPLANNED: "held",
  FUNDING_ABANDONED: "held",
  FUNDING_AFTER_ABANDON: "held",
  FUNDING_AMBIGUOUS: "held",
  FUNDING_MISMATCH: "held",
  CREATE_AMBIGUOUS: "held",
  PAYMENT_REFUSED: "held",
  FAILURE_RECORDED: "held",
  LATE_FAILURE: "held",
  UNKNOWN_STATUS: "held",
  TRANSFER_MISMATCH: "held",
  TRANSFER_AFTER_ABANDON: "held",
  STATUS_AFTER_DEAD: "held",
  INTENT_STALE: "held",
  ESCALATED: "person",
  ESCALATION_RESOLVED: "person",
  DRAFT_REPLY: "person",
  DRAFT_RESOLVED: "person",
  INBOX_RECEIVED: "person",
  CLOSED: "proof",
  CERTIFICATE_REVOKED: "proof",
  CHAIN_REBASELINED: "proof",
  AGENT_TOOL_CALL: "agent",
  AGENT_WAKE: "agent",
  AGENT_WAKE_FINISHED: "agent",
  AGENT_DEFERRED: "agent",
  EVIDENCE_RECORDED: "agent",
  INCIDENT_REACTION: "agent",
  WEBHOOK_RECEIVED: "agent",
};

export const bandOf = (type: string): Band => BAND_OF[type] ?? "agent";

/** Money the code refused to move, per currency, as one line. Used by the landing board and the control panel. */
export function heldBackLine(metrics: Metrics | null): string {
  if (!metrics) return "—";
  const lines = Object.entries(metrics.refusedAmountMinor).filter(([, minor]) => minor > 0);
  if (lines.length === 0) return money(0, "USD");
  return lines.map(([currency, minor]) => money(minor, currency)).join(" + ");
}

export interface Tick {
  at: number;
  counts: Record<Band, number>;
}

export interface Activity {
  ticks: Tick[];
  /** The tallest tick's total, never 0, so a chart can divide by it. */
  max: number;
  total: number;
  /** True when the window holds nothing at all: the chart says so instead of drawing an empty grid. */
  empty: boolean;
}

export interface Window {
  now: number;
  /** How long one tick covers, and how many of them are drawn (the newest tick ends at `now`). */
  tickMs: number;
  ticks: number;
}

const emptyCounts = (): Record<Band, number> => ({ moved: 0, held: 0, person: 0, proof: 0, agent: 0 });

/** The activity of every incident's ledger, bucketed over the last `ticks × tickMs`, oldest bucket first. */
export function activity(views: readonly IncidentView[], { now, tickMs, ticks }: Window): Activity {
  const from = now - ticks * tickMs;
  const buckets: Tick[] = Array.from({ length: ticks }, (_, i) => ({ at: from + i * tickMs, counts: emptyCounts() }));
  let total = 0;
  for (const view of views) {
    for (const event of view.events) {
      const at = Date.parse(event.ts);
      if (Number.isNaN(at) || at < from || at > now) continue;
      // The last bucket is inclusive of `now`, so an event landing exactly on the edge is never dropped.
      const index = Math.min(ticks - 1, Math.floor((at - from) / tickMs));
      buckets[index]!.counts[bandOf(event.type)] += 1;
      total += 1;
    }
  }
  const max = buckets.reduce((peak, bucket) => Math.max(peak, BANDS.reduce((sum, band) => sum + bucket.counts[band], 0)), 0);
  return { ticks: buckets, max: Math.max(1, max), total, empty: total === 0 };
}

export interface Column {
  id: string;
  reference: string;
  amountMinor: number;
  currency: string;
  status: IncidentSummary["status"];
  method: IncidentSummary["method"];
  updatedAt: string;
  /** Where the last thing that happened to it sits on the chart's own bands. */
  band: Band;
  /** What a person sees in the tooltip: the agent's last verdict there, or nothing yet. */
  note: string | null;
}

const BAND_OF_STATUS: Record<IncidentSummary["status"], Band> = {
  OPEN: "agent",
  PAYING: "moved",
  PAID: "moved",
  NEEDS_ACTION: "person",
  ESCALATED: "person",
  CLOSED: "proof",
};

export interface Exposure {
  columns: Column[];
  /** The tallest amount on the board, never 0. */
  maxMinor: number;
  /** What the board is holding, per currency: the headline number, honestly split. */
  totals: { currency: string; minor: number; count: number }[];
  waiting: number;
}

const NOTE_OF_ATTENTION: Record<NonNullable<IncidentSummary["attention"]>["kind"], string> = {
  ESCALATED: "Handed to a person",
  NEEDS_ACTION: "Needs a decision",
  DRAFT: "Draft reply waiting",
};

/** One column per incident, oldest first, plus the totals the headline shows. Amounts stay in their own currency. */
export function exposure(items: readonly IncidentSummary[]): Exposure {
  const columns = [...items]
    .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt))
    .map<Column>((item) => ({
      id: item.id,
      reference: item.reference,
      amountMinor: item.amountMinor,
      currency: item.currency,
      status: item.status,
      method: item.method,
      updatedAt: item.updatedAt,
      band: item.attention ? "person" : BAND_OF_STATUS[item.status],
      note: item.attention
        ? NOTE_OF_ATTENTION[item.attention.kind]
        : item.latest?.failureCode
          ? `Last failure ${item.latest.failureCode}`
          : item.latest
            ? `Attempt ${item.latest.seq}`
            : null,
    }));

  const byCurrency = new Map<string, { minor: number; count: number }>();
  for (const item of items) {
    const entry = byCurrency.get(item.currency) ?? { minor: 0, count: 0 };
    entry.minor += item.amountMinor;
    entry.count += 1;
    byCurrency.set(item.currency, entry);
  }

  return {
    columns,
    maxMinor: Math.max(1, ...columns.map((c) => c.amountMinor)),
    totals: [...byCurrency].map(([currency, entry]) => ({ currency, ...entry })).sort((a, b) => b.minor - a.minor),
    waiting: items.filter((item) => item.attention !== null).length,
  };
}

/** The clock labels under a chart: local time, or a date once a bucket is too wide for a clock to mean anything. */
export function clockLabel(at: number, tickMs = 60_000): string {
  if (tickMs >= 6 * 3_600_000) return new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** The smallest bucket width that still fits the oldest event on the board into `ticks` buckets. */
export function windowFor(views: readonly IncidentView[], now: number, ticks = 24): Window {
  const stamps = views.flatMap((view) => view.events.map((event) => Date.parse(event.ts))).filter((at) => !Number.isNaN(at));
  const span = Math.max(1, now - Math.min(now, ...(stamps.length > 0 ? stamps : [now])));
  const tickMs = TICK_CHOICES.find((choice) => choice * ticks >= span) ?? TICK_CHOICES.at(-1)!;
  return { now, tickMs, ticks };
}

const TICK_CHOICES = [60_000, 5 * 60_000, 15 * 60_000, 3_600_000, 6 * 3_600_000, 86_400_000] as const;
