import type { Tone } from "@/components/ui";
import { titleCase } from "@/lib/format";
import { lookupFailure, type FailureClass } from "../../src/domain/playbook";
import type { IncidentSummary, IncidentView } from "../../src/server/wire";

export type ObligationStatus = IncidentSummary["status"];
export type AttemptState = IncidentView["attempts"][number]["state"];

interface Look {
  label: string;
  tone: Tone;
  /** The marker blinks while the thing is still moving. */
  pulse: boolean;
}

/** Only blue, black and white: blue means money is processing or has settled, black means a person owns it. */
export const STATUS: Record<ObligationStatus, Look> = {
  OPEN: { label: "Open", tone: "muted", pulse: false },
  PAYING: { label: "Processing", tone: "blue-outline", pulse: true },
  PAID: { label: "Paid", tone: "blue", pulse: false },
  NEEDS_ACTION: { label: "Needs a decision", tone: "outline", pulse: true },
  ESCALATED: { label: "With a person", tone: "ink", pulse: true },
  CLOSED: { label: "Certified", tone: "outline", pulse: false },
};

export const ATTEMPT: Record<AttemptState, Look> = {
  INTENT: { label: "Recorded", tone: "muted", pulse: true },
  LIVE: { label: "Processing", tone: "blue-outline", pulse: true },
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

/** What the playbook makes of each class of failure, in the words an operator would use. */
const FAILURE_CLASS: Record<FailureClass, string> = {
  FIX_DETAILS: "Fix the details",
  SUPPLIER_ACCOUNT: "Supplier's account",
  TRANSIENT: "Temporary fault",
  FUNDING_OR_LIMITS: "Funding or limits",
  POSSIBLE_DUPLICATE: "Possible duplicate",
  COMPLIANCE_OR_RECALL: "Compliance or recall",
  CORRIDOR_UNSUPPORTED: "Unsupported corridor",
  UNKNOWN: "Unrecognized failure",
};

/** A failure code as the playbook reads it: its name and the class it falls in. Unknown codes say so. */
export function describeFailure(code: string): { name: string; playbook: string } {
  const entry = lookupFailure(code);
  return {
    name: entry.code === "UNRECOGNIZED" ? "Unrecognized code" : titleCase(entry.failureType),
    playbook: FAILURE_CLASS[entry.class],
  };
}
