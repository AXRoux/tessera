"use client";

import { Button, Frame, Label, PanelHeader } from "../ui";
import type { RunAction } from "../console/actions-panel";
import { AgentTimeline, useAgentRun } from "./agent-run";

/** Lets Claude work this one incident through the toolbox. It can only do what the code allows, and says so on screen. */
export function AgentPanel({
  incidentId,
  modelAvailable,
  sandbox,
  busy,
  run,
  refresh,
}: {
  incidentId: string;
  modelAvailable: boolean;
  sandbox: boolean;
  busy: string | null;
  run: RunAction;
  refresh: () => void;
}) {
  const { state, start } = useAgentRun(refresh);
  const working = busy === "agent";
  const adversary = state.mode === "adversary";

  return (
    <Frame tone="blue">
      <PanelHeader title={adversary && state.status !== "idle" ? "Adversary agent" : "Commander agent"} right={<Label className={adversary ? "text-ink" : "text-blue"}>{state.actor ?? "Claude"}</Label>} />
      <div className="space-y-5 p-5">
        <p className="max-w-2xl text-sm leading-relaxed text-muted">
          Hand this incident to Claude. It works through a small, fixed set of typed tools and nothing else: it cannot create a transfer, sign an
          approval or change an amount. The code refuses anything unsafe, and every step lands in the ledger under the agent&rsquo;s name.
          {sandbox ? " On the sandbox you can also tell the same agent to get the supplier paid twice, and watch the code refuse." : ""}
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <Button
            disabled={!modelAvailable || (busy !== null && !working)}
            busy={working}
            onClick={() => run("agent", () => start(incidentId))}
          >
            {working && !adversary ? "Claude is working" : "Let Claude work this incident"}
          </Button>
          {sandbox ? (
            <Button
              variant="secondary"
              disabled={!modelAvailable || (busy !== null && !working)}
              busy={working && adversary}
              onClick={() => run("agent", () => start(incidentId, "adversary"))}
            >
              {working && adversary ? "Claude is attacking" : "Try to break it"}
            </Button>
          ) : null}
          {!modelAvailable ? (
            <span className="text-xs text-muted">Set ANTHROPIC_API_KEY and TESSERA_MODEL on the API server to enable this.</span>
          ) : null}
        </div>
      </div>
      {state.status !== "idle" ? (
        <div className="border-t border-rule">
          <AgentTimeline state={state} />
        </div>
      ) : null}
    </Frame>
  );
}
