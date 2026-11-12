"use client";

import Link from "next/link";
import type { Health } from "../../../src/server/wire";
import { Icon } from "../landing/icons";

import { AgentMark } from "../kit/agent-mark";
import { AgentTimeline, agentName, useAgentRun } from "./agent-run";
import { Btn } from "../kit/metal";

/**
 * Hands this one incident to the agent through the toolbox. It can only do what the code allows, and says so on
 * screen. The run belongs to the app, not this page: leaving keeps it going, and only one runs at a time.
 */
export function AgentPanel({ incidentId, health, refresh }: { incidentId: string; health: Health | null; refresh: () => void }) {
  const agent = useAgentRun(refresh);
  const sandbox = health?.sandbox ?? false;
  // Agent-agnostic: "the agent" in every sentence; the connected model is named once, as metadata.
  const model = health?.agent ? agentName(health.agent, true) : null;
  const mine = agent.target === incidentId && agent.state.status !== "idle";
  const elsewhere = agent.running && !mine;
  const runningMode = agent.running && mine ? agent.state.mode : null;
  const available = Boolean(health?.agent);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-3">
        <p className="text-[12.5px] leading-relaxed text-fg/65">
          Hand this incident to the agent. It works through ten typed tools and nothing more: it cannot create a transfer, sign an approval or alter an amount, and every step is
          written to the ledger under its name. What it should not settle alone comes back to you.
          {sandbox ? " Or test the guardrails: tell it to get the supplier paid twice, and watch the code decline." : ""}
        </p>
        <div className={`grid items-center gap-2 ${sandbox && !runningMode ? "grid-cols-[minmax(0,1fr)_auto]" : "grid-cols-1"}`}>
          {runningMode ? (
            <Btn tone="secondary" block onClick={agent.stop}>
              Stop the agent
            </Btn>
          ) : (
            <>
              <Btn block disabled={!available || agent.running} onClick={() => agent.start(incidentId)} icon={<AgentMark size={20} />}>
                Let the agent work this
              </Btn>
              {sandbox ? (
                <Btn tone="secondary" disabled={!available || agent.running} onClick={() => agent.start(incidentId, "adversary")} icon={<Icon name="shield" className="size-4" />}>
                  Test the guardrails
                </Btn>
              ) : null}
            </>
          )}
        </div>
        {!available ? (
          <p className="text-[12px] leading-relaxed text-fg/50">No agent is connected. Configure a model on the API server (any supported provider), or run the offline demo, to bring one in.</p>
        ) : (
          <p className="readout text-[11px] text-fg/40">connected model · {model}</p>
        )}
        {elsewhere ? (
          <p className="text-[12px] leading-relaxed text-fg/50">
            The agent is already at work{" "}
            {agent.target ? (
              <Link href={`/incidents/${agent.target}`} className="text-accent underline underline-offset-4 hover:text-fg">
                on another incident
              </Link>
            ) : (
              <Link href="/dashboard" className="text-accent underline underline-offset-4 hover:text-fg">
                on the board
              </Link>
            )}
            . One run at a time.
          </p>
        ) : null}
      </div>
      {mine ? (
        <div className="mt-4 flex min-h-0 flex-1 flex-col border-t border-fg/[0.06] pt-3">
          <span className="kicker shrink-0">{agent.state.mode === "adversary" ? "The guardrail test, step by step" : "The run, step by step"}</span>
          <AgentTimeline state={agent.state} idFor={() => incidentId} dense className="min-h-0 flex-1 pt-3" />
        </div>
      ) : (
        <div className="well mt-4 flex min-h-[120px] flex-1 flex-col items-center justify-center gap-2 rounded-[22px]! px-6 text-center">
          <AgentMark size={36} className="rounded-[10px]" />
          <p className="max-w-[280px] text-[12.5px] leading-relaxed text-fg/55">Start a run and each tool the agent reaches for, and each answer the code gives, will appear here in order.</p>
        </div>
      )}
    </div>
  );
}
