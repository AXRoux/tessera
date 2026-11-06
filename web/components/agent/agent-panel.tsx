"use client";

import Link from "next/link";
import type { Health } from "../../../src/server/wire";
import { Button, Frame, Label, PanelHeader } from "../ui";
import { AgentTimeline, agentName, useAgentRun } from "./agent-run";

/**
 * Hands this one incident to the agent through the toolbox. It can only do what the code allows, and says so on
 * screen. The run belongs to the app, not this page: leaving keeps it going, and only one runs at a time.
 */
export function AgentPanel({ incidentId, health, refresh }: { incidentId: string; health: Health | null; refresh: () => void }) {
  const agent = useAgentRun(refresh);
  const sandbox = health?.sandbox ?? false;
  const name = agentName(health?.agent);
  const Name = agentName(health?.agent, true);
  const mine = agent.target === incidentId && agent.state.status !== "idle";
  const elsewhere = agent.running && !mine;
  const runningMode = agent.running && mine ? agent.state.mode : null;
  const adversary = mine && agent.state.mode === "adversary";
  const available = Boolean(health?.agent);

  return (
    <Frame tone="blue">
      <PanelHeader
        title={adversary ? "Adversary agent" : "Commander agent"}
        right={
          <span className="flex items-center gap-4">
            {runningMode ? (
              <button type="button" onClick={agent.stop} className="label cursor-pointer text-ink hover:text-blue">
                Stop
              </button>
            ) : null}
            <Label className={adversary ? "text-ink" : "text-blue"}>{(mine ? agent.state.actor : null) ?? Name}</Label>
          </span>
        }
      />
      <div className="space-y-5 p-5">
        <p className="max-w-2xl text-sm leading-relaxed text-muted">
          Hand this incident to {name}. It works through a small, fixed set of typed tools and nothing else: it cannot create a transfer, sign an
          approval or change an amount. The code refuses anything unsafe, and every step lands in the ledger under the agent&rsquo;s name.
          {health?.agent?.kind === "scripted" ? " Offline, the agent is a deterministic script, not a model: it shows the same tools and the same refusals." : ""}
          {sandbox ? " On the sandbox you can also tell the same agent to get the supplier paid twice, and watch the code refuse." : ""}
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <Button disabled={!available || agent.running} busy={runningMode === "commander"} onClick={() => agent.start(incidentId)}>
            {runningMode === "commander" ? `${Name} is working` : `Let ${name} work this incident`}
          </Button>
          {sandbox ? (
            <Button
              variant="secondary"
              disabled={!available || agent.running}
              busy={runningMode === "adversary"}
              onClick={() => agent.start(incidentId, "adversary")}
            >
              {runningMode === "adversary" ? `${Name} is attacking` : "Try to break it"}
            </Button>
          ) : null}
          {!available ? (
            <span className="text-xs text-muted">Set ANTHROPIC_API_KEY and TESSERA_MODEL on the API server, or run the offline demo, to enable this.</span>
          ) : null}
          {elsewhere ? (
            <span className="text-xs text-muted">
              An agent run is already in progress{" "}
              {agent.target ? (
                <Link href={`/incidents/${agent.target}`} className="underline underline-offset-4 hover:text-blue">
                  on another incident
                </Link>
              ) : (
                <Link href="/" className="underline underline-offset-4 hover:text-blue">
                  on the board
                </Link>
              )}
              . One run at a time.
            </span>
          ) : null}
        </div>
      </div>
      {mine ? (
        <div className="border-t border-rule">
          <AgentTimeline state={agent.state} />
        </div>
      ) : null}
    </Frame>
  );
}
