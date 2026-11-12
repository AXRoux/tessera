"use client";

import type { Health, IncidentSummary } from "../../../src/server/wire";
import { agentName, AgentTimeline, useAgentRun } from "../agent/agent-run";
import { RunReport } from "../agent/run-report";
import { Button, Label, Tag } from "../ui";

/**
 * The agent's run: what it reached for, what the code answered, and the two buttons that start it. The transcript is
 * the same component the landing page uses, so a run looks identical wherever it is watched from.
 */
export function RunPanel({ items, health }: { items: IncidentSummary[]; health: Health | null }) {
  const agent = useAgentRun();
  const name = agentName(health?.agent);
  const Name = agentName(health?.agent, true);
  const live = agent.running;
  const available = Boolean(health?.agent) && items.length > 0;
  const done = agent.state.steps.filter((step) => step.kind === "tool").length;
  const refused = agent.state.done?.refused ?? agent.state.steps.filter((step) => step.kind === "tool" && step.result?.kind === "refused").length;
  const handed = agent.state.steps.filter((step) => step.kind === "tool" && step.result?.ok && (step.tool === "escalate_to_human" || step.tool === "draft_supplier_reply")).length;

  return (
    <section id="agent" data-shell-section className="panel flex min-w-0 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-white/[0.075] px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h2 className="text-[15px] font-medium tracking-[-0.01em]">Agent</h2>
            <Tag tone={health?.agent ? "blue-outline" : "muted"} pulse={live}>
              {!health?.agent ? "Not configured" : live ? "Working" : "Ready"}
            </Tag>
          </div>
          <p className="mt-1 text-[12.5px] text-muted">
            {health?.agent?.kind === "scripted"
              ? "A deterministic script, not a model: same ten tools, same refusals."
              : `Ten typed tools over MCP. ${Name} reads, asks and drafts; the code decides what is allowed.`}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2.5">
          {live ? (
            <Button variant="secondary" onClick={agent.stop}>
              Stop
            </Button>
          ) : (
            <>
              <Button disabled={!available} onClick={() => agent.start(null)}>
                Let {name} work them all
              </Button>
              {health?.sandbox ? (
                <Button variant="secondary" disabled={!available} onClick={() => agent.start(null, "adversary")}>
                  Try to break it
                </Button>
              ) : null}
            </>
          )}
          {agent.state.status !== "idle" ? (
            <button type="button" onClick={agent.clear} className="cursor-pointer px-1 text-[12.5px] text-muted underline underline-offset-4 hover:text-white">
              Clear
            </button>
          ) : null}
        </div>
      </header>

      {agent.state.status === "idle" ? (
        <div className="flex flex-1 flex-col justify-center gap-3 px-6 py-14 text-center">
          <p className="text-[15px] text-soft">Nothing has run yet</p>
          <p className="mx-auto max-w-lg text-[13px] leading-relaxed text-muted">
            {available
              ? "Start a run and every tool call, every refusal and every handoff to a person lands here in order, next to the row it belongs to."
              : items.length === 0
                ? "Load the incidents first: the agent works the board, not an empty room."
                : "No agent is connected to this server, so nothing can run."}
          </p>
        </div>
      ) : (
        <>
          <RunReport state={agent.state} idFor={(reference) => items.find((item) => item.reference === reference)?.id} />
          <div className="flex flex-wrap items-center gap-x-8 gap-y-2 px-5 py-3.5 text-[12.5px] text-muted">
            <span className="flex items-baseline gap-2">
              <Label className="tnum text-[14px] text-white">{done}</Label> tool calls
            </span>
            <span className="flex items-baseline gap-2">
              <Label className="tnum text-[14px] text-danger">{refused}</Label> refused by code
            </span>
            <span className="flex items-baseline gap-2">
              <Label className="tnum text-[14px] text-sky">{handed}</Label> handed to a person
            </span>
            {live ? (
              <span className="ml-auto flex items-center gap-2 text-soft">
                <span aria-hidden className="beat size-1.5 rounded-full bg-blue" />
                streaming
              </span>
            ) : null}
          </div>
          <div className="thin-scroll max-h-[560px] overflow-y-auto overscroll-contain">
            <AgentTimeline state={agent.state} idFor={(reference) => items.find((item) => item.reference === reference)?.id} />
          </div>
        </>
      )}
    </section>
  );
}
