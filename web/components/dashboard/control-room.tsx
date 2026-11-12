"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Health, IncidentSummary, IncidentView, Metrics, Wallets } from "../../../src/server/wire";
import { useBoard } from "@/lib/use-board";
import { useAgentRun } from "../agent/agent-run";
import { revisionOf, useViews } from "@/lib/use-views";
import { useWallets } from "@/lib/use-wallets";
import { Composer } from "./composer";
import { Masthead } from "./masthead";
import { Workspace } from "../shell";
import { ControlPanel } from "./control-panel";
import { IncidentsPanel } from "./incidents-panel";
import { Queue } from "./queue";
import { RunPanel } from "./run-panel";
import { Sequence } from "./sequence";
import { WalletPanel } from "./wallet-panel";

/** A message that should be seen but not shove the layout: it floats, then leaves on its own. */
function Toast({ tone, children, onClose }: { tone: "ok" | "bad"; children: React.ReactNode; onClose: () => void }) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const timer = setTimeout(() => close.current(), 7000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div
      role={tone === "bad" ? "alert" : "status"}
      className="tile rise fixed bottom-5 right-5 z-50 flex max-w-[420px] items-start gap-3 px-4 py-3 text-[13px] leading-relaxed"
    >
      <span aria-hidden className={`mt-1.5 size-2 shrink-0 rounded-full ${tone === "bad" ? "bg-bad" : "bg-accent"}`} />
      <span className="min-w-0 flex-1">{children}</span>
      <button type="button" onClick={onClose} className="cursor-pointer text-fg/50 hover:text-fg" aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}

/**
 * The control room, composed to fit one 16:9 screen and read in order, left to right:
 * 01 the money Tessera guards, 02 what it holds and how the board looks, 03 the agent working it, 04 what is left for you.
 * The loop across the top says which move comes next.
 */
export function ControlRoom({
  health,
  initial,
  initialMetrics,
  initialWallets,
  initialViews,
  compose = false,
}: {
  /** Open the payout composer on arrival (links from the landing page and the loop). */
  compose?: boolean;
  health: Health | null;
  initial: IncidentSummary[];
  initialMetrics: Metrics | null;
  initialWallets: Wallets | null;
  initialViews: IncidentView[];
}) {
  const board = useBoard({ items: initial, metrics: initialMetrics, health });
  const views = useViews(initialViews, revisionOf(board.items));
  const wallets = useWallets(initialWallets);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [composing, setComposing] = useState(compose);
  // Once there is a run to read, the agent's column takes the room from the queue below it.
  const runShown = useAgentRun().state.status !== "idle";
  const openComposer = useCallback(() => setComposing(true), []);
  const closeComposer = useCallback(() => setComposing(false), []);

  const extras = (
    <>
      {health?.canReset ? (
        board.confirmingReset ? (
          <span className="flex items-center gap-2 text-[12px]">
            <button type="button" onClick={board.reset} disabled={board.resetting} className="cursor-pointer text-bad hover:text-fg">
              {board.resetting ? "Clearing…" : "Clear everything"}
            </button>
            <button type="button" onClick={() => board.setConfirmingReset(false)} className="cursor-pointer text-fg/50 hover:text-fg">
              Keep
            </button>
          </span>
        ) : (
          <button type="button" onClick={() => board.setConfirmingReset(true)} className="cursor-pointer text-[12px] text-fg/55 hover:text-fg">
            Start over
          </button>
        )
      ) : null}
    </>
  );

  return (
    <Workspace>
      <div className="grid shrink-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.85fr)] lg:items-stretch">
        <Masthead items={board.items} metrics={board.metrics} running={board.running} health={health} />
        <Sequence items={board.items} metrics={board.metrics} health={health} onCompose={openComposer} onRun={board.run} running={board.running} extras={extras} />
      </div>

      <div className="grid min-h-0 gap-4 xl:flex-1 xl:grid-cols-[minmax(270px,300px)_minmax(0,1fr)_minmax(320px,360px)] 2xl:grid-cols-[330px_minmax(0,1fr)_390px]">
        <div className="min-h-[560px] xl:min-h-0 [&>section]:h-full">
          <WalletPanel wallets={wallets} health={health} items={board.items} onCompose={openComposer} />
        </div>

        <div className="flex min-h-0 min-w-0 flex-col gap-4">
          <div className="flex min-h-[420px] flex-col xl:min-h-0 xl:flex-[1.75] short:flex-[2] [&>section]:flex-1">
            <ControlPanel items={board.items} metrics={board.metrics} views={views} onCompose={openComposer} />
          </div>
          <div className="flex min-h-[320px] flex-col xl:min-h-0 xl:flex-1 [&>section]:flex-1">
            <IncidentsPanel items={board.items} onCompose={openComposer} />
          </div>
        </div>

        <div className="flex min-h-0 min-w-0 flex-col gap-4">
          <div className={`flex min-h-[420px] flex-col overflow-hidden xl:min-h-0 [&>section]:flex-1 ${runShown ? "xl:flex-[1.75]" : "xl:flex-[1.4]"}`}>
            <RunPanel items={board.items} health={health} />
          </div>
          <div className="flex min-h-[260px] flex-col overflow-hidden xl:min-h-[190px] xl:flex-1 [&>section]:flex-1">
            <Queue items={board.items} />
          </div>
        </div>
      </div>

      <Composer open={composing} onClose={closeComposer} health={health} create={board.create} creating={board.creating} />
      {!health ? (
        <Toast tone="bad" onClose={() => undefined}>
          The Tessera API could not be reached, so the room is empty. Start it with <span className="readout text-[12px]">bun run demo</span>.
        </Toast>
      ) : null}
      {board.error && dismissed !== board.error ? (
        <Toast tone="bad" onClose={() => setDismissed(board.error)}>
          {board.error}
        </Toast>
      ) : null}
      {board.seeded && dismissed !== board.seeded ? (
        <Toast tone="ok" onClose={() => setDismissed(board.seeded)}>
          {board.seeded}
        </Toast>
      ) : null}
    </Workspace>
  );
}
