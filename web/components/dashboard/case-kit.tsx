"use client";

/**
 * The shared vocabulary of a supplier issue, used by the case map and the lanes alike: who made a move, what kind of
 * move it was as a colour, and where a case stands in words.
 */
import type { CaseOutcome, CaseStep, IncidentSummary } from "../../../src/server/wire";
import { AgentMark } from "../kit/agent-mark";
import { Icon } from "../landing/icons";
import { SupplierMark } from "../suppliers/supplier-mark";

export type Lane = IncidentSummary & { case: NonNullable<IncidentSummary["case"]> };
export type State = CaseOutcome["state"];

export const ACTOR: Record<CaseStep["actor"], string> = {
  agent: "Agent",
  test: "Guardrail test",
  you: "You",
  airwallex: "Airwallex",
  visa: "Visa",
  supplier: "Supplier",
  tessera: "Tessera",
};

/** What a step was, as a colour: red is stopped or failed, amber a person's part, blue the agent acting, green money landed. */
export function pillTone(step: CaseStep): string {
  switch (step.kind) {
    case "refused":
    case "fail":
    case "investigate":
      return "bg-bad/12 text-bad ring-bad/35";
    case "handoff":
    case "draft":
    case "sign":
    case "release":
    case "send":
    case "resolve":
      return "bg-warn/12 text-warn ring-warn/35";
    case "paid":
    case "cleared":
    case "certify":
      return "bg-ok/14 text-ok ring-ok/40";
    case "act":
      return "bg-accent/14 text-accent ring-accent/35";
    default:
      return "bg-fg/[0.06] text-fg/80 ring-fg/12";
  }
}

/** Who made the move, as a mark small enough to sit inside a pill. */
export function Who({ step, lane, size = 12 }: { step: Pick<CaseStep, "actor">; lane: Lane; size?: 11 | 12 }) {
  const box = size === 11 ? "size-[11px] shrink-0" : "size-3 shrink-0";
  switch (step.actor) {
    case "agent":
      return <AgentMark size={size} className="shrink-0 rounded-[3px]" />;
    case "test":
      return <Icon name="shield" className={box} />;
    case "you":
      return <Icon name="hand" className={box} />;
    case "airwallex":
      return <Icon name="wallet" className={box} />;
    case "visa":
      return <span className="shrink-0 font-sans text-[8.5px] font-black italic leading-none tracking-[-0.02em]">VISA</span>;
    case "supplier":
      return lane.supplier ? <SupplierMark supplier={lane.supplier} size={size + 2} /> : <Icon name="mail" className={box} />;
    case "tessera":
      return <Icon name="badge" className={box} />;
  }
}

/** Where a case stands, in a word or two, and its colour. */
export const STATE_WORDS: Record<State, { word: string; text: string; dot: string }> = {
  open: { word: "Unresolved", text: "text-bad", dot: "bg-bad" },
  working: { word: "In progress", text: "text-accent", dot: "bg-accent" },
  yours: { word: "Waiting on you", text: "text-warn", dot: "bg-warn" },
  solved: { word: "Resolved", text: "text-ok", dot: "bg-ok" },
  certified: { word: "Resolved and certified", text: "text-ok", dot: "bg-ok" },
};

/** The counts a header shows, in the order a case travels: red, blue, amber, green. */
export function tally(lanes: Lane[]) {
  const count = (states: State[]) => lanes.filter((l) => states.includes(l.case.outcome.state)).length;
  return { open: count(["open"]), working: count(["working"]), yours: count(["yours"]), solved: count(["solved", "certified"]), certified: count(["certified"]) };
}

/** Where the transfer stands at Airwallex, in words a person reads. */
export function bankWords(lane: Pick<IncidentSummary, "latest" | "attemptCount">): string {
  const latest = lane.latest;
  if (!latest) return "Not sent";
  const words =
    latest.state === "PAID" ? "Paid"
      : latest.state === "DEAD" ? `Cancelled${latest.failureCode ? ` (${latest.failureCode})` : ""}`
        : latest.state === "INTENT" ? "Being sent"
          : latest.awxStatus === "SENT" ? "In transit"
            : latest.awxStatus === "FAILED" ? "Failed, awaiting cancel"
              : "Processing";
  return lane.attemptCount > 1 ? `${words} · attempt ${latest.seq}` : words;
}
