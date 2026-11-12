"use client";

import { useMemo, useState } from "react";
import type { IncidentSummary, IncidentView, Metrics } from "../../../src/server/wire";
import { activity, BANDS, clockLabel, exposure, windowFor, type Band } from "@/lib/activity";
import { ago, duration, money } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { Label } from "../ui";
import { ActivityChart, Legend, ValueChart } from "./charts";

/** Money the code refused to move, per currency, as one line. */
function heldBack(metrics: Metrics | null): string {
  if (!metrics) return "—";
  const lines = Object.entries(metrics.refusedAmountMinor).filter(([, minor]) => minor > 0);
  if (lines.length === 0) return money(0, "USD");
  return lines.map(([currency, minor]) => money(minor, currency)).join(" + ");
}

function Tile({ label, value, sub }: { label: string; value: string | number; sub: string }) {
  return (
    <div className="rounded-2xl border border-white/[0.09] bg-white/[0.055] px-4 py-3">
      <dt className="text-[11.5px] leading-tight text-white/65">{label}</dt>
      <dd className="tnum mt-2 text-[22px] font-light leading-none">{value}</dd>
      <dd className="mt-1.5 text-[11px] leading-tight text-white/50">{sub}</dd>
    </div>
  );
}

const TABS = ["Value", "Activity"] as const;

/**
 * The control panel: what the board is holding, how much of it the code stopped, and the ledger's own history.
 * Everything here is derived from the incidents and their ledger; nothing is estimated.
 */
export function ControlPanel({
  items,
  metrics,
  views,
  onSeed,
  seeding,
  canSeed,
}: {
  items: IncidentSummary[];
  metrics: Metrics | null;
  views: IncidentView[];
  onSeed: () => void;
  seeding: boolean;
  canSeed: boolean;
}) {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Value");
  const now = useNow(4000);
  const board = useMemo(() => exposure(items), [items]);
  const window = useMemo(() => windowFor(views, now), [views, now]);
  const history = useMemo(() => activity(views, window), [views, window]);
  const last = items.reduce<string | null>((newest, item) => (newest === null || item.updatedAt > newest ? item.updatedAt : newest), null);
  const bands: readonly Band[] = BANDS;

  const waiting = board.waiting;
  const subline = metrics
    ? `${metrics.open} open · ${waiting} with a person · ${metrics.certified} certified · ${metrics.paymentsRefused} refused by code`
    : "Reading the board…";

  return (
    <div id="overview" data-shell-section className="flex min-w-0 flex-col gap-6">
      <section className="glow-panel flex min-w-0 flex-col p-6 lg:p-7">
      <header className="flex flex-wrap items-start justify-between gap-x-8 gap-y-5">
        <div className="min-w-0">
          <Label className="text-white/60">Under control</Label>
          <div className="mt-2 flex flex-wrap items-baseline gap-x-5 gap-y-1">
            {board.totals.length === 0 ? (
              <span className="tnum text-[clamp(30px,3.6vw,42px)] font-light leading-none">{money(0, "USD")}</span>
            ) : (
              board.totals.map((total) => (
                <span key={total.currency} className="tnum text-[clamp(30px,3.6vw,42px)] font-light leading-none">
                  {money(total.minor, total.currency)}
                </span>
              ))
            )}
            <span className="text-[12px] text-white/60">
              {board.totals.length > 1 ? `across ${board.totals.length} currencies` : items.length === 1 ? "1 invoice" : `${items.length} invoices`}
            </span>
          </div>
          <p className="mt-3 text-[13px] text-white/70">{subline}</p>
        </div>

        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-black/20 px-3.5 py-1.5 text-[12px] text-white/80">
            <span aria-hidden className="beat size-1.5 rounded-full bg-[#7ee0a1]" />
            {last === null ? "Waiting" : <span suppressHydrationWarning>Updated {ago(last, now)}</span>}
          </span>
          <div
            role="tablist"
            aria-label="Chart"
            className="flex rounded-full border border-white/15 bg-black/25 p-0.5"
            onKeyDown={(event) => {
              if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
              event.preventDefault();
              const next = TABS[(TABS.indexOf(tab) + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length]!;
              setTab(next);
            }}
          >
            {TABS.map((name) => (
              <button
                key={name}
                role="tab"
                aria-selected={tab === name}
                tabIndex={tab === name ? 0 : -1}
                onClick={() => setTab(name)}
                className={`cursor-pointer rounded-full px-3.5 py-1.5 text-[12.5px] transition-colors ${tab === name ? "bg-white text-black" : "text-white/70 hover:text-white"}`}
              >
                {name}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="mt-7 grid min-w-0 gap-6 lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-7 xl:grid-cols-[215px_minmax(0,1fr)]">
        <dl className="order-1 flex flex-col gap-2.5">
          <Tile label="Held back by code" value={metrics?.paymentsRefused ?? "—"} sub={heldBack(metrics)} />
          <Tile label="Replaced automatically" value={metrics?.autoReplaced ?? "—"} sub="inside the automatic limit" />
          <Tile label="Handed to a person" value={waiting} sub="waiting on a decision" />
          <Tile label="Median time to certify" value={metrics?.medianResolutionMs != null ? duration(metrics.medianResolutionMs) : "—"} sub="after the hold window" />
        </dl>

        <div className="order-2 min-w-0">
          {items.length === 0 && canSeed ? (
            <div className="flex h-[268px] flex-col items-center justify-center gap-4 text-center">
              <p className="text-[15px] text-white">The board is empty</p>
              <p className="max-w-md text-[13px] leading-relaxed text-white/70">
                Seven invoices, each broken in a different way. Load them and every branch of the playbook lands on the board at once.
              </p>
              <button type="button" onClick={onSeed} disabled={seeding} className="cursor-pointer rounded-full bg-white px-5 py-2.5 text-[13.5px] text-black disabled:opacity-60">
                Load the incidents
              </button>
            </div>
          ) : tab === "Value" ? (
            <ValueChart exposure={board} />
          ) : (
            <ActivityChart activity={history} tickMs={window.tickMs} tall />
          )}
        </div>
      </div>

      <footer className="mt-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-white/[0.12] pt-4">
        <Legend bands={bands} />
        <p className="text-[11.5px] text-white/55">
          {tab === "Value" ? "One column per incident, scaled to the largest amount on the board; amounts stay in their own currency." : `One column per ${window.tickMs >= 3_600_000 ? "hour" : "minute"}, stacked by what happened`}
        </p>
      </footer>
      </section>

      <section className="panel min-w-0 p-5">
        <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <div>
            <h2 className="text-[14px] font-medium tracking-[-0.01em]">Ledger activity</h2>
            <p className="mt-0.5 text-[12px] text-muted">
              Every event the ledger appended in the last {window.ticks} {window.tickMs >= 3_600_000 ? "hours" : "minutes"}, from {clockLabel(history.ticks[0]!.at, window.tickMs)}
            </p>
          </div>
          <span className="tnum text-[12px] text-muted">{history.total} events</span>
        </header>
        <div className="mt-4">
          <ActivityChart activity={history} tickMs={window.tickMs} />
        </div>
      </section>
    </div>
  );
}
