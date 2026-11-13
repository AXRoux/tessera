"use client";

import { useEffect, useRef, useState } from "react";
import type { Health, IncidentSummary } from "../../../src/server/wire";
import { summarizeRun } from "@/lib/run-summary";
import { actionLabel, AgentTimeline, useAgentRun } from "../agent/agent-run";
import { AgentMark } from "../kit/agent-mark";
import { Icon } from "../landing/icons";
import { Btn } from "../kit/metal";
import { Chip, clock, Kicker, Readout, RingSquare, Ticker, Tile, Tray, TrayHead, useTick } from "../kit/widgets";

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
  const available = Boolean(health?.agent) && items.length > 0;
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
  const ticker = live
    ? lastTool
      ? `${actionLabel(lastTool.tool).toLowerCase()}${lastTool.incident ? ` · ${lastTool.incident}` : ""}…`
      : "reading the board…"
    : headline ?? (available ? `ten typed tools · no keys to the vault` : items.length === 0 ? "send a payout first" : "no agent connected");

  return (
    <Tray label="The agent" className="h-full gap-3 overflow-hidden p-3">
      <TrayHead
        n={3}
        className="px-2 pt-1"
        title="Agent"
        note={model ? `Connected model · ${model}` : "No agent connected"}
        right={<Chip tone={live ? "accent" : health?.agent ? "solid" : "neutral"} pulse={live}>{!health?.agent ? "Offline" : live ? (adversary ? "Attacking" : "Working") : "Ready"}</Chip>}
      />

      <Tile className={`flex shrink-0 items-center gap-4 ${active ? "p-3" : "p-4 short:p-3"}`}>
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

      {live ? (
        <Btn tone="secondary" block onClick={agent.stop}>
          Stop the run
        </Btn>
      ) : active ? (
        // After a run the transcript is what matters: the controls shrink to one row of short labels.
        <div className={`grid shrink-0 gap-2 ${health?.sandbox ? "grid-cols-2" : "grid-cols-1"}`}>
          <Btn block disabled={!available} onClick={() => agent.start(null)} icon={<AgentMark size={18} />} title="Let the agent work the board">
            Run again
          </Btn>
          {health?.sandbox ? (
            <Btn tone="secondary" block disabled={!available} onClick={() => agent.start(null, "adversary")} icon={<Icon name="shield" className="size-4" />} title="Test the guardrails">
              Guardrails
            </Btn>
          ) : null}
        </div>
      ) : screen === "shorter" ? (
        <div className={`grid shrink-0 gap-2 ${health?.sandbox ? "grid-cols-2" : "grid-cols-1"}`}>
          <Btn block disabled={!available} onClick={() => agent.start(null)} icon={<AgentMark size={18} />} title="Let the agent work the board">
            Run agent
          </Btn>
          {health?.sandbox ? (
            <Btn tone="secondary" block disabled={!available} onClick={() => agent.start(null, "adversary")} icon={<Icon name="shield" className="size-4" />} title="Test the guardrails">
              Guardrails
            </Btn>
          ) : null}
        </div>
      ) : (
        <div className="flex shrink-0 flex-col gap-2">
          <Btn block disabled={!available} onClick={() => agent.start(null)} icon={<AgentMark size={20} />}>
            Let the agent work the board
          </Btn>
          {health?.sandbox ? (
            <Btn tone="secondary" block disabled={!available} onClick={() => agent.start(null, "adversary")} icon={<Icon name="shield" className="size-4" />}>
              Test the guardrails
            </Btn>
          ) : null}
        </div>
      )}

      {!active ? (
        // Two short lines, sized to their content: never cut off, whatever room the column has left.
        <div className="well flex min-h-[56px] flex-1 flex-col items-center justify-center gap-1 rounded-[22px]! px-5 py-2.5 text-center">
          <p className="text-[13.5px] font-medium leading-tight">Quiet, for now</p>
          <p className="max-w-full truncate text-[12px] leading-tight text-fg/50">Every call, refusal and handoff lands here.</p>
        </div>
      ) : (
        <div className="tile flex min-h-[160px] flex-1 flex-col overflow-hidden rounded-[22px]! xl:min-h-0">
          <div className="flex shrink-0 items-center justify-between border-b border-fg/[0.06] px-4 py-2.5">
            <Kicker>{adversary ? "The guardrail test, step by step" : "The run, step by step"}</Kicker>
            {!live ? (
              <button type="button" onClick={agent.clear} className="well cursor-pointer rounded-full! px-2.5 py-1 text-[11px] font-medium text-fg/60 hover:text-fg">
                Clear
              </button>
            ) : null}
          </div>
          <AgentTimeline state={agent.state} idFor={idFor} dense className="min-h-0 flex-1 px-4 pb-3 pt-3" />
        </div>
      )}
    </Tray>
  );
}
