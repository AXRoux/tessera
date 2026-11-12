"use client";

import { useMemo, useState } from "react";
import type { IncidentSummary, IncidentView, Metrics } from "../../../src/server/wire";
import { activity, exposure, heldBackLine, windowFor, windowLabel } from "@/lib/activity";
import { duration, money } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { Btn } from "../kit/metal";
import { Gauge, Kicker, Readout, Tile, Toggle, type ChipTone } from "../kit/widgets";
import { ActivityChart, Legend, ValueChart } from "./charts";

/** One gauge and its caption: a reading the room can take from across the desk. */
function Meter({ label, value, of, tone, sub }: { label: string; value: number; of: number; tone: ChipTone; sub: string }) {
  return (
    <div className="flex min-w-0 flex-col items-center" title={sub}>
      <Gauge label={`${label}: ${value} of ${of}`} value={of > 0 ? value / of : 0} tone={tone} dots={[Math.min(value, 5), Math.min(Math.max(of, 1), 5)]} className="size-[88px] short:size-[64px]">
        <span className="readout text-[24px] font-medium leading-none short:text-[18px]">{value}</span>
      </Gauge>
      <span className="mt-1 max-w-full truncate text-center text-[11.5px] text-fg/60 short:text-[10.5px]">{label}</span>
    </div>
  );
}

type View = "invoice" | "time";

/**
 * Step two, and the one black tile on a white board (the one white tile on a black board): what Tessera is holding,
 * four gauges for what has become of it, and its shape over invoices or over time. Derived from the ledger; nothing estimated.
 */
export function ControlPanel({
  items,
  metrics,
  views,
  onCompose,
}: {
  items: IncidentSummary[];
  metrics: Metrics | null;
  views: IncidentView[];
  onCompose: () => void;
}) {
  const [view, setView] = useState<View>("invoice");
  const now = useNow(4000);
  const board = useMemo(() => exposure(items), [items]);
  const window = useMemo(() => windowFor(views, now), [views, now]);
  const history = useMemo(() => activity(views, window), [views, window]);
  const total = items.length;

  return (
    <Tile invert as="section" className="flex min-h-0 flex-col rounded-[30px]! p-5 xl:p-6">
      <header className="flex shrink-0 items-start justify-between gap-4">
        <div className="min-w-0">
          <Kicker>02 · Under Tessera&rsquo;s watch</Kicker>
          <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            {(board.totals.length === 0 ? [{ currency: "USD", minor: 0 }] : board.totals).map((t) => (
              <span key={t.currency} className="readout text-[clamp(30px,2.6vw,42px)] font-medium leading-none tracking-[-0.04em] short:text-[clamp(26px,2.2vw,32px)]">
                {money(t.minor, t.currency)}
              </span>
            ))}
            <span className="readout text-[12.5px] text-accent">
              {total === 1 ? "1 invoice" : `${total} invoices`}
              {board.totals.length > 1 ? ` · ${board.totals.length} currencies` : ""}
            </span>
          </div>
        </div>
        <Toggle
          label="Chart"
          value={view}
          onChange={setView}
          options={[
            { id: "invoice", label: "By invoice" },
            { id: "time", label: "Over time" },
          ]}
        />
      </header>

      <div className="mt-4 grid min-h-0 flex-1 grid-cols-[minmax(196px,220px)_minmax(0,1fr)] gap-5 short:mt-3 short:grid-cols-[minmax(150px,170px)_minmax(0,1fr)] short:gap-4">
        <div className="grid min-h-0 grid-cols-2 content-center gap-x-2 gap-y-3 short:gap-y-1.5">
          <Meter label="Waiting on you" value={board.waiting} of={total} tone="warn" sub="Decisions the agent left for a person" />
          <Meter label="Replaced" value={metrics?.autoReplaced ?? 0} of={total} tone="accent" sub="Replaced on its own, inside the automatic limit" />
          <Meter label="Stopped" value={metrics?.paymentsRefused ?? 0} of={Math.max(total, metrics?.paymentsRefused ?? 0)} tone="bad" sub={`${heldBackLine(metrics)} the code refused to move`} />
          <Meter label="Certified" value={metrics?.certified ?? 0} of={total} tone="solid" sub="Reconciled against Airwallex and sealed" />
        </div>

        <div className="min-h-[120px] min-w-0 short:min-h-0">
          {items.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <p className="text-[16px] font-medium">Nothing in Tessera&rsquo;s care yet</p>
              <p className="max-w-md text-[13px] leading-relaxed text-fg/60">Send a payout and it appears here, followed status by status as the bank reports it.</p>
              <Btn onClick={onCompose}>Send the first payout</Btn>
            </div>
          ) : view === "invoice" ? (
            <ValueChart exposure={board} />
          ) : (
            <ActivityChart activity={history} />
          )}
        </div>
      </div>

      <footer className="mt-3 flex shrink-0 items-center justify-between gap-4 border-t border-fg/10 pt-3 short:mt-2 short:pt-2">
        <div className="min-w-0 shorter:hidden">
          <Legend />
        </div>
        <span className="flex shrink-0 items-center gap-2.5">
          <span className="text-[11.5px] text-fg/50">{view === "time" ? `Last ${windowLabel(window)}` : "Time to certify"}</span>
          <Readout size="sm" value={view === "time" ? String(history.total).padStart(2, "0") : metrics?.medianResolutionMs != null ? duration(metrics.medianResolutionMs) : "--:--"} />
        </span>
      </footer>
    </Tile>
  );
}
