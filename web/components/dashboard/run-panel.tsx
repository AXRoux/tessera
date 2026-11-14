"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { Health, IncidentSummary } from "../../../src/server/wire";
import { summarizeRun } from "@/lib/run-summary";
import { money } from "@/lib/format";
import { agentPlan, leftBecause, type Move } from "@/lib/next-moves";
import { actionLabel, AgentTimeline, useAgentRun } from "../agent/agent-run";
import { AgentMark } from "../kit/agent-mark";
import { Icon } from "../landing/icons";
import { Btn } from "../kit/metal";
import { Select } from "../kit/select";
import { Chip, clock, Kicker, Readout, RingSquare, STATUS_CHIP, Ticker, Tile, Tray, TrayHead, useTick } from "../kit/widgets";

/** How short the one-screen layout is: the `short` (under 960 tall) and `shorter` (under 780) variants, from 1280 wide. */
function useScreenHeight(): "tall" | "short" | "shorter" {
  const [height, setHeight] = useState<"tall" | "short" | "shorter">("tall");
  useEffect(() => {
    const short = window.matchMedia("(min-width: 1280px) and (max-height: 960px)");
    const shorter = window.matchMedia("(min-width: 1280px) and (max-height: 780px)");
    const sync = () => setHeight(shorter.matches ? "shorter" : short.matches ? "short" : "tall");
    sync();
    short.addEventListener("change", sync);
    shorter.addEventListener("change", sync);
    return () => {
      short.removeEventListener("change", sync);
      shorter.removeEventListener("change", sync);
    };
  }, []);
  return height;
}

/** How long the current (or last) run has taken: started when it starts, frozen when it ends. */
function useRunClock(running: boolean): number | null {
  const started = useRef<number | null>(null);
  const [ended, setEnded] = useState<number | null>(null);
  const now = useTick(1000);
  useEffect(() => {
    if (running) {
      started.current = Date.now();
      setEnded(null);
    } else if (started.current !== null) setEnded(Date.now());
  }, [running]);
  if (started.current === null) return null;
  return (ended ?? now) - started.current;
}

/** The plan before a run: the invoices the agent will work, each with its move, then the ones it leaves alone and why. */
function Plan({ plan, empty }: { plan: { work: Move[]; leave: Move[]; certified: number }; empty: boolean }) {
  const row = (move: Move, right: string, tone: string) => (
    <li key={move.item.id} className="flex items-center justify-between gap-3 py-1 2xl:py-1.5">
      <span className="min-w-0 truncate">
        <span className="readout text-[12px] font-medium">{move.item.reference}</span>
        <span className="text-[11.5px] text-fg/40"> · {money(move.item.amountMinor, move.item.currency)}</span>
      </span>
      <span className={`shrink-0 text-[11.5px] ${tone}`}>{right}</span>
    </li>
  );
  return (
    <div className="well thin-scroll flex min-h-[56px] flex-1 flex-col overflow-y-auto rounded-[22px]! px-4 py-2">
      {empty ? (
        <p className="m-auto text-center text-[12px] leading-snug text-fg/50">Send a payout first. The agent only works invoices in the ledger.</p>
      ) : (
        <>
          <Kicker>{plan.work.length > 0 ? "It will work" : "Nothing for it to do"}</Kicker>
          {plan.work.length > 0 ? <ul className="divide-y divide-fg/[0.06]">{plan.work.map((m) => row(m, m.label, "text-accent"))}</ul> : null}
          {plan.leave.length > 0 ? (
            <>
              <Kicker className="mt-2">It leaves alone</Kicker>
              <ul className="divide-y divide-fg/[0.06]">{plan.leave.map((m) => row(m, leftBecause(m), m.who === "you" ? "text-warn" : "text-fg/45"))}</ul>
            </>
          ) : null}
          {plan.certified > 0 ? <p className="mt-2 text-[11.5px] text-fg/40">{plan.certified} certified, never touched again.</p> : null}
        </>
      )}
    </div>
  );
}

/**
 * Step three, as the reference's power widget: a ring around the agent's mark that runs while it works, a run clock in
 * a well, and a ticker with the tool it is reaching for. Below it, every step and every answer the code gave.
 */
export function RunPanel({ items, health }: { items: IncidentSummary[]; health: Health | null }) {
  const agent = useAgentRun();
  // Tessera is agent-agnostic: the panel speaks of "the agent", and the connected model is shown as metadata.
  const model = health?.agent ? (health.agent.kind === "scripted" ? "scripted (not a model)" : health.agent.name) : null;
  const live = agent.running;
  const elapsed = useRunClock(live);
  const idFor = (reference: string) => items.find((item) => item.reference === reference)?.id;
  const tools = agent.state.steps.filter((step) => step.kind === "tool");
  const refused = agent.state.done?.refused ?? tools.filter((step) => step.result?.kind === "refused").length;
  const handed = tools.filter((step) => step.result?.ok && (step.tool === "escalate_to_human" || step.tool === "draft_supplier_reply")).length;
  const lastTool = tools.at(-1);
  const headline = agent.state.status === "done" || agent.state.status === "error" ? summarizeRun(agent.state.steps, agent.state.mode).headline : null;
  const active = agent.state.status !== "idle";
  const adversary = agent.state.mode === "adversary" && active;
  // On a short screen the idle widget tightens (and on the shortest, the two buttons share a row), so the empty run
  // log below always has room for its two lines.
  const screen = useScreenHeight();
  const compactRing = screen !== "tall";
  // What "work the board" will do, said before it starts: exactly these invoices, and why the others are left alone.
  const plan = agentPlan(items, { reader: health ? health.reader !== null : true });
  // The guardrail test runs on one invoice the person picks: open ones first, since they have the most to attempt.
  const guardId = useId();
  const [guardOn, setGuardOn] = useState<string | null>(null);
  const guardable = [...items.filter((i) => i.status !== "CLOSED"), ...items.filter((i) => i.status === "CLOSED")];
  const guardTarget = guardable.find((i) => i.id === guardOn)?.id ?? guardable[0]?.id ?? null;
  const guardOptions = guardable.map((i) => ({ value: i.id, label: i.reference, hint: `${money(i.amountMinor, i.currency)} · ${STATUS_CHIP[i.status].label.toLowerCase()}` }));
  const ticker = live
    ? lastTool
      ? `${actionLabel(lastTool.tool).toLowerCase()}${lastTool.incident ? ` · ${lastTool.incident}` : ""}…`
      : "reading the board…"
    : headline ?? (!health?.agent ? "no agent connected" : items.length === 0 ? "send a payout first" : `${plan.work.length} to work · ${plan.leave.length} left alone · ${plan.certified} certified`);

  return (
    <Tray label="The agent" className="h-full gap-3 overflow-hidden p-3">
      <TrayHead
        n={3}
        className="px-2 pt-1"
        title="Agent"
        note={model ? `Connected model · ${model}` : "No agent connected"}
        right={<Chip tone={live ? "accent" : health?.agent ? "solid" : "neutral"} pulse={live}>{!health?.agent ? "Offline" : live ? (adversary ? "Attacking" : "Working") : "Ready"}</Chip>}
      />

      {/* Idle, the plan below says everything the dial would; on a short screen the plan gets its room. */}
      <Tile className={`flex shrink-0 items-center gap-4 ${active ? "p-3" : "p-4 short:hidden"}`}>
        <RingSquare value={active ? 1 : 0} spinning={live} tone={adversary ? "bad" : "accent"} size={active ? 64 : compactRing ? 56 : 84}>
          <AgentMark size={active ? 34 : compactRing ? 30 : 44} className="rounded-[12px]" />
        </RingSquare>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <Kicker>{live ? (adversary ? "Guardrail test" : "Run time") : active ? (adversary ? "Last guardrail test" : "Last run") : "Idle"}</Kicker>
            <Readout size={active || compactRing ? "sm" : "md"} value={elapsed === null ? "00:00" : clock(elapsed)} />
          </div>
          <Ticker>{ticker}</Ticker>
          {active ? (
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
              <span className="text-fg/55">
                <span className="readout font-medium text-fg">{String(tools.length).padStart(2, "0")}</span> calls
              </span>
              <span className="text-fg/55">
                <span className="readout font-medium text-bad">{String(refused).padStart(2, "0")}</span> refused
              </span>
              <span className="text-fg/55">
                <span className="readout font-medium text-warn">{String(handed).padStart(2, "0")}</span> to you
              </span>
            </div>
          ) : null}
        </div>
      </Tile>

      {active ? (
        <>
          {live ? (
            <Btn tone="secondary" block onClick={agent.stop}>
              Stop the run
            </Btn>
          ) : (
            // After a run the transcript is what matters; the plan comes back when you are done reading.
            <Btn tone="secondary" block onClick={agent.clear}>
              Back to the plan
            </Btn>
          )}
          <div className="tile flex min-h-[160px] flex-1 flex-col overflow-hidden rounded-[22px]! xl:min-h-0">
            <div className="flex shrink-0 items-center justify-between border-b border-fg/[0.06] px-4 py-2.5">
              <Kicker className="shrink-0">{adversary ? "Guardrail test" : "Step by step"}</Kicker>
              {agent.state.scope ? (
                <span className="readout min-w-0 truncate pl-3 text-[11px] text-fg/45" title={agent.state.scope}>
                  {adversary ? "on " : ""}
                  {agent.state.scope}
                </span>
              ) : null}
            </div>
            <AgentTimeline state={agent.state} idFor={idFor} dense className="min-h-0 flex-1 px-4 pb-3 pt-3" />
          </div>
        </>
      ) : (
        <>
          <Btn block disabled={!health?.agent || plan.work.length === 0} onClick={() => agent.start(plan.work.map((m) => m.item.id))} icon={<AgentMark size={20} />}>
            {plan.work.length === 0 ? "Nothing for the agent to do" : `Let the agent work ${plan.work.length === 1 ? plan.work[0]!.item.reference : `${plan.work.length} invoices`}`}
          </Btn>
          <Plan plan={plan} empty={items.length === 0} />
          {health?.sandbox ? (
            <div className="shrink-0 space-y-1.5">
              <label htmlFor={guardId} className="kicker block px-1">
                Test the guardrails on
              </label>
              <div className="flex gap-2">
                <div className="min-w-0 flex-1">
                  <Select id={guardId} value={guardTarget ?? ""} onChange={setGuardOn} options={guardOptions} disabled={guardOptions.length === 0} minListWidth={260} />
                </div>
                <Btn
                  tone="secondary"
                  disabled={!health?.agent || !guardTarget}
                  onClick={() => guardTarget && agent.start(guardTarget, "adversary")}
                  icon={<Icon name="shield" className="size-4" />}
                  title="The agent is told to cheat on this invoice only: pay it twice, certify it early, fund what it does not need. Every attempt should be refused."
                >
                  Test
                </Btn>
              </div>
            </div>
          ) : null}
        </>
      )}
    </Tray>
  );
}
