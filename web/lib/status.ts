import type { Tone } from "@/components/ui";
import type { IncidentSummary, IncidentView } from "../../src/server/wire";

export type ObligationStatus = IncidentSummary["status"];
export type AttemptState = IncidentView["attempts"][number]["state"];

interface Look {
  label: string;
  tone: Tone;
  /** The marker blinks while the thing is still moving. */
  pulse: boolean;
}

/** Only blue, black and white: blue means money is moving or landed, black means a person owns it. */
export const STATUS: Record<ObligationStatus, Look> = {
  OPEN: { label: "Open", tone: "muted", pulse: false },
  PAYING: { label: "In flight", tone: "blue-outline", pulse: true },
  PAID: { label: "Paid", tone: "blue", pulse: false },
  NEEDS_ACTION: { label: "Needs action", tone: "outline", pulse: true },
  ESCALATED: { label: "Escalated", tone: "ink", pulse: true },
  CLOSED: { label: "Certified", tone: "outline", pulse: false },
};

export const ATTEMPT: Record<AttemptState, Look> = {
  INTENT: { label: "Intent", tone: "muted", pulse: true },
  LIVE: { label: "In flight", tone: "blue-outline", pulse: true },
  PAID: { label: "Paid", tone: "blue", pulse: false },
  DEAD: { label: "Cancelled", tone: "ink", pulse: false },
  ABANDONED: { label: "Never sent", tone: "muted", pulse: false },
};

export const SQUARE: Record<AttemptState, string> = {
  INTENT: "border border-ink border-dashed",
  LIVE: "border border-blue bg-wash",
  PAID: "bg-blue",
  DEAD: "bg-ink",
  ABANDONED: "border border-rule",
};
