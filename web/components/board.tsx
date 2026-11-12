"use client";

import { useState } from "react";
import type { Health, IncidentSummary, Metrics } from "../../src/server/wire";
import { agentName, AgentTimeline, useAgentRun } from "./agent/agent-run";
import { AgentRail } from "./agent-rail";
import { IncidentTable } from "./incidents-table";
import { Logo } from "./logo";
import { Tour } from "./tour";
import { Button, LinkButton } from "./ui";
import { duration, money } from "@/lib/format";
import { useBoard } from "@/lib/use-board";

function heldBack(metrics: Metrics): string {
  const lines = Object.entries(metrics.refusedAmountMinor).filter(([, minor]) => minor > 0);
  if (lines.length === 0) return money(0, "USD");
  return lines.map(([currency, minor]) => money(minor, currency)).join(" + ");
}

/** One line of numbers instead of a strip that eats a third of the fold. */
function Kpis({ metrics, awaiting }: { metrics: Metrics | null; awaiting: number }) {
  const read = (f: (m: Metrics) => string | number): string | number => (metrics ? f(metrics) : "—");
  const cells: readonly (readonly [string, string | number])[] = [
    ["Tracked", read((m) => m.incidents)],
    ["Refused by code", read((m) => m.paymentsRefused)],
    ["Money held back", read(heldBack)],
    ["Replaced", read((m) => m.autoReplaced)],
    ["Certified", read((m) => m.certified)],
    ["Median certify", read((m) => (m.medianResolutionMs === null ? "—" : duration(m.medianResolutionMs)))],
    ["Awaiting you", awaiting],
  ];
  return (
    <dl className="flex flex-wrap items-center gap-x-7 gap-y-2 text-[13px]">
      {cells.map(([label, value]) => (
        <div key={label} className="flex items-baseline gap-2">
          <dd className="tnum text-[15px] font-medium">{value}</dd>
          <dt className="text-muted">{label}</dt>
        </div>
      ))}
    </dl>
  );
}

/** The live board, as the landing page embeds it: the walkthrough, the agent run, the queue and the whole table. */
export function Board({ initial, initialMetrics, health }: { initial: IncidentSummary[]; initialMetrics: Metrics | null; health: Health | null }) {
  const board = useBoard({ items: initial, metrics: initialMetrics, health });
  const agent = useAgentRun();
  const [showTable, setShowTable] = useState(false);

  const idFor = (reference: string) => board.items.find((i) => i.reference === reference)?.id;
  const name = agentName(health?.agent);
  const running = agent.running;

  return (
    <div className="mx-auto max-w-[1200px] px-6 sm:px-10">
      {health?.offline ? (
        <p className="flex items-start gap-3 text-[13px] leading-snug text-muted">
          <span aria-hidden className="mt-[6px] size-1.5 shrink-0 rounded-full bg-sky" />
          {health.agent?.kind === "model"
            ? `Offline demo: simulated Airwallex, agent runs by ${health.agent.name}. No money and no bank are involved.`
            : "Offline demo: simulated Airwallex, scripted agent. The agent is a deterministic script, not a model."}
        </p>
      ) : null}

      <Tour items={board.items} metrics={board.metrics} health={health} onSeed={board.seed} onRun={(mode) => agent.start(null, mode)} seeding={board.seeding} running={running} />

      <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,7fr)_minmax(0,4fr)]">
        <div className="min-w-0">
          {agent.state.status === "idle" ? (
            <section className="card flex flex-col items-center gap-4 px-6 py-16 text-center">
              <Logo size={40} />
              <p className="heading text-[26px]">{board.canSeed ? "The board is quiet" : "Nothing has happened yet"}</p>
              <p className="max-w-md text-[14px] font-light leading-relaxed text-soft">
                {board.canSeed
                  ? `${name.charAt(0).toUpperCase() + name.slice(1)} works the board through ten typed tools. Start it, and every call and refusal lands here in order.`
                  : "Send a payout to open your first incident. Tessera records the instruction before any money moves."}
              </p>
              <div className="mt-2 flex flex-wrap justify-center gap-3">
                {board.items.length > 0 ? <Button onClick={() => agent.start(null)}>Let the agent work the board</Button> : null}
                <LinkButton href="/dashboard?compose=1" variant="secondary">
                  Send a real payout
                </LinkButton>
              </div>
            </section>
          ) : (
            <section className="card overflow-hidden">
              <header className="flex flex-wrap items-center justify-between gap-4 border-b border-rule px-5 py-4">
                <div>
                  <div className="flex items-center gap-3">
                    <span className="text-[15px] font-medium">{agent.state.mode === "adversary" ? "Adversary run" : "Agent run"}</span>
                    <span className={`text-[12px] ${running ? "text-sky" : "text-muted"}`}>{running ? "Working" : "Finished"}</span>
                  </div>
                  <p className="mt-1 text-[13px] text-muted">
                    {agent.state.mode === "adversary" ? "Told to pay twice and talk its way past the rules. Every refusal is the point." : "What the agent tried, and what the code answered."}
                  </p>
                </div>
                <button type="button" onClick={agent.clear} className="cursor-pointer text-[13px] text-muted underline underline-offset-4 hover:text-white">
                  Clear
                </button>
              </header>
              <AgentTimeline state={agent.state} idFor={idFor} />
            </section>
          )}
        </div>

        <AgentRail
          health={health}
          metrics={board.metrics}
          items={board.items}
          awaiting={board.waiting}
          onSeed={board.seed}
          canSeed={board.canSeed}
          seeding={board.seeding}
        />
      </div>

      <div className="mt-8 flex flex-wrap items-center justify-between gap-4">
        <Kpis metrics={board.metrics} awaiting={board.waiting} />
        <div className="flex flex-wrap items-center gap-2.5">
          <Button variant="quiet" onClick={() => setShowTable((open) => !open)}>
            {showTable ? "Hide the table" : `All incidents (${board.items.length})`}
          </Button>
          {board.canSeed ? (
            <Button variant="secondary" onClick={board.seed} busy={board.seeding}>
              Seed incidents
            </Button>
          ) : null}
          {health?.canReset ? (
            board.confirmingReset ? (
              <>
                <Button onClick={board.reset} busy={board.resetting}>
                  Confirm reset
                </Button>
                <Button variant="quiet" onClick={() => board.setConfirmingReset(false)} disabled={board.resetting}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button variant="quiet" onClick={() => board.setConfirmingReset(true)}>
                Reset demo
              </Button>
            )
          ) : null}
        </div>
      </div>

      {board.error ? (
        <p role="alert" className="mt-6 rounded-2xl border border-danger/50 bg-danger/10 px-5 py-4 text-sm">
          {board.error}
        </p>
      ) : null}
      {board.seeded ? (
        <p role="status" className="mt-6 rounded-2xl border border-blue/50 bg-wash px-5 py-4 text-sm">
          {board.seeded}
        </p>
      ) : null}

      {showTable ? (
        <div className="card mt-6 overflow-x-auto">
          <IncidentTable items={board.items} empty="No incidents yet." />
        </div>
      ) : null}
    </div>
  );
}
