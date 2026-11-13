"use client";

import type { Health, IncidentSummary, Metrics } from "../../../src/server/wire";
import { AgentMark } from "../kit/agent-mark";
import { guideCopy } from "../guide";
import { Icon } from "../landing/icons";
import { Btn, LinkBtn } from "../kit/metal";
import { Kicker, Tray } from "../kit/widgets";
import { useTourState } from "../tour";
import type { TourStepId } from "@/lib/tour-steps";

/** The next move in a few words: the dock has one line for it (the full explanation is on hover). */
function nextLine(id: TourStepId, takeover: { reference: string } | null): string {
  switch (id) {
    case "seed":
      return "Send a payout. Tessera seals it before a cent moves.";
    case "agent":
      return "Let the agent work the board. The code has the last word.";
    case "adversary":
      return "Tell the agent to cheat, and watch the code refuse.";
    case "takeover":
      return takeover ? `${takeover.reference} is waiting on your decision.` : "Nothing needs you yet. Run the agent again.";
    case "certify":
      return "Mark a payment paid, then certify it.";
  }
}

interface Props {
  items: IncidentSummary[];
  metrics: Metrics | null;
  health: Health | null;
  /** Opens the payout composer: the loop starts with a real payout, not scripted data. */
  onCompose: () => void;
  onRun: (mode: "commander" | "adversary") => void;
  running: boolean;
  /** Controls for the whole demo (seed more, start over), set quietly at the dock's edge. */
  extras?: React.ReactNode;
}

/** One move of the loop as a key on a dock: done is a blue tick, current is the raised black key, pending a recessed one. */
function Key({ n, title, done, current }: { n: number; title: string; done: boolean; current: boolean }) {
  if (current) {
    return (
      <li aria-current="step" className="tile inverse flex h-11 shrink-0 items-center gap-2.5 rounded-[14px]! pl-1.5 pr-3.5 text-fg">
        <span className="readout flex size-8 items-center justify-center rounded-[10px] bg-accent text-[12px] font-medium text-white">{String(n).padStart(2, "0")}</span>
        <span className="text-[12.5px] font-medium">{title}</span>
      </li>
    );
  }
  return (
    <li title={title} className={`flex h-11 shrink-0 items-center gap-2 rounded-[14px] pl-1.5 pr-3 ${done ? "tile" : "well"}`}>
      <span className={`readout flex size-8 items-center justify-center rounded-[10px] text-[12px] font-medium ${done ? "text-accent" : "text-fg/40"}`}>
        {done ? <Icon name="check" className="size-[18px]" /> : String(n).padStart(2, "0")}
      </span>
      <span className={`hidden text-[12px] 2xl:inline ${done ? "text-fg/70" : "text-fg/40"}`}>{title}</span>
    </li>
  );
}

/**
 * The five moves of the demo as a dock: where you are, what is done, and the single next action in liquid metal.
 * Derived from the board, so a reload lands on the same step.
 */
export function Sequence({ items, metrics, health, onCompose, onRun, running, extras }: Props) {
  const tour = useTourState(items, metrics);
  const detail = guideCopy({ health, takeover: tour.takeover, onRun, running, compact: true });
  const current = tour.steps.find((step) => step.id === tour.current) ?? null;
  const idle = !health?.agent || running;

  const action = (() => {
    if (!current) return null;
    switch (current.id) {
      case "seed":
        return (
          <Btn onClick={onCompose} disabled={running}>
            Send a payout
          </Btn>
        );
      case "adversary":
        return (
          <Btn onClick={() => onRun("adversary")} busy={running} disabled={idle} icon={<Icon name="shield" className="size-4" />}>
            Test the guardrails
          </Btn>
        );
      case "takeover":
        if (tour.takeover) return <LinkBtn href={`/queue?id=${tour.takeover.id}`} icon={<Icon name="hand" className="size-4" />}>Decide on {tour.takeover.reference}</LinkBtn>;
        return (
          <Btn onClick={() => onRun("commander")} busy={running} disabled={idle} icon={<AgentMark size={18} />}>
            Run the agent again
          </Btn>
        );
      default:
        return (
          <Btn onClick={() => onRun("commander")} busy={running} disabled={idle} icon={<AgentMark size={18} />}>
            {current.id === "agent" ? "Let the agent work" : "Run the agent again"}
          </Btn>
        );
    }
  })();

  return (
    <Tray label="The loop" className="justify-center gap-2.5 px-3 py-3">
      <div className="flex min-w-0 items-center gap-3 px-1">
        <Kicker className="hidden shrink-0 sm:block">Human in the loop</Kicker>
        <ol className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden" aria-label="Five moves">
          {tour.steps.map((step, i) => (
            <Key key={step.id} n={i + 1} title={step.title} done={step.done} current={step.id === tour.current} />
          ))}
        </ol>
        <span className="readout shrink-0 text-[11.5px] text-fg/45">
          {tour.doneCount}/{tour.total}
        </span>
        {extras ? <span className="hidden shrink-0 items-center gap-3 border-l border-fg/10 pl-3 sm:flex">{extras}</span> : null}
      </div>
      <div className="flex min-w-0 flex-col gap-3 px-1 sm:flex-row sm:items-center sm:gap-4">
        <p className="min-w-0 flex-1 truncate text-[13px] leading-snug text-fg/70" title={current ? detail[current.id].text : undefined}>
          {current ? (
            <>
              <span className="font-medium text-accent">Next · </span>
              {nextLine(current.id, tour.takeover)}
            </>
          ) : (
            "Loop complete. Send another payout to go again."
          )}
        </p>
        <div className="shrink-0">{action}</div>
      </div>
    </Tray>
  );
}
