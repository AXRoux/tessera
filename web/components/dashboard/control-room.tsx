"use client";

import type { Health, IncidentSummary, IncidentView, Metrics, Wallets } from "../../../src/server/wire";
import { PageHead, Stage, useShellReport } from "../shell";
import { Guide } from "../tour";
import { useTourState } from "../tour";
import { useBoard } from "@/lib/use-board";
import { revisionOf, useViews } from "@/lib/use-views";
import { useWallets } from "@/lib/use-wallets";
import { Button } from "../ui";
import { ControlPanel } from "./control-panel";
import { IncidentsPanel } from "./incidents-panel";
import { Queue } from "./queue";
import { RunPanel } from "./run-panel";
import { WalletPanel } from "./wallet-panel";

/**
 * The control room: the walkthrough until it is done, then the numbers, the agent, the queue and the table. Every
 * section is a target the rail can jump to, and the rail's badges are reported up from here.
 */
export function ControlRoom({
  health,
  initial,
  initialMetrics,
  initialWallets,
  initialViews,
}: {
  health: Health | null;
  initial: IncidentSummary[];
  initialMetrics: Metrics | null;
  initialWallets: Wallets | null;
  initialViews: IncidentView[];
}) {
  const board = useBoard({ items: initial, metrics: initialMetrics, health });
  const views = useViews(initialViews, revisionOf(board.items));
  const wallets = useWallets(initialWallets);
  const tour = useTourState(board.items, board.metrics);
  useShellReport({ awaiting: board.waiting, guide: { done: tour.doneCount, total: tour.total } });

  return (
    <Stage>
      <PageHead
        title="Control room"
        note="What Tessera is holding, what the agent is doing with it, and what is waiting for a person. Everything here is read from the ledger the API keeps."
      >
        {board.canSeed ? (
          <Button variant="secondary" onClick={board.seed} busy={board.seeding}>
            {board.items.length === 0 ? "Load the incidents" : "Seed incidents"}
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
      </PageHead>

      <section id="guide" data-shell-section className="panel mt-7 p-6">
        <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <div>
            <h2 className="text-[15px] font-medium tracking-[-0.01em]">{tour.complete ? "The whole loop, seen" : "Getting started"}</h2>
            <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-muted">
              {tour.complete
                ? "All five ran against this board: incidents loaded, the agent worked them, the code refused what it should, a person took one over, one certified."
                : "Five steps that follow what you actually do. Each one is derived from the board, so a reload lands you back on the step you were on."}
            </p>
          </div>
          <span className={`tnum text-[13px] ${tour.complete ? "text-[#7ee0a1]" : "text-sky"}`}>
            {tour.doneCount}/{tour.total}
          </span>
        </header>
        <Guide
          items={board.items}
          metrics={board.metrics}
          health={health}
          onSeed={board.seed}
          onRun={(mode) => board.run(mode)}
          seeding={board.seeding}
          running={board.running}
        />
      </section>

      <div className="mt-6 grid min-w-0 gap-6 xl:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        <WalletPanel wallets={wallets} health={health} onCreate={board.create} creating={board.creating} />
        <ControlPanel items={board.items} metrics={board.metrics} views={views} onSeed={board.seed} seeding={board.seeding} canSeed={board.canSeed} />
      </div>

      <div className="mt-6 grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <RunPanel items={board.items} health={health} />
        <Queue items={board.items} />
      </div>

      <div className="mt-6">
        <IncidentsPanel items={board.items} onSeed={board.seed} seeding={board.seeding} canSeed={board.canSeed} />
      </div>

      {board.error ? (
        <p role="alert" className="mt-6 rounded-2xl border border-danger/50 bg-danger/10 px-5 py-4 text-sm">
          {board.error}
        </p>
      ) : null}
      {board.seeded ? (
        <p role="status" className="mt-6 rounded-2xl border border-sky/40 bg-wash px-5 py-4 text-sm">
          {board.seeded}
        </p>
      ) : null}
      {!health ? (
        <p role="status" className="mt-6 rounded-2xl border border-white/15 bg-white/[0.03] px-5 py-4 text-sm text-soft">
          The API could not be reached, so the board is empty. Start it with <span className="font-mono text-[13px]">bun run demo</span>.
        </p>
      ) : null}
    </Stage>
  );
}
