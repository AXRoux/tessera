"use client";

import Link from "next/link";
import { useState } from "react";
import { ago, money } from "@/lib/format";
import { BAND_STYLE, BANDS, clockLabel, type Activity, type Band, type Exposure } from "@/lib/activity";
import { STATUS_CHIP } from "../kit/widgets";

/**
 * The hero's two charts, drawn as DOM capsules so they stay crisp and every column is a real button. Colours are palette
 * variables, so the same chart reads on a black tile in light mode and a white one in dark.
 */

const AXIS = 56;
const tint = (color: string, pct: number) => `color-mix(in oklab, ${color} ${pct}%, transparent)`;

function axisCurrency(exposure: Exposure): string {
  const tallest = exposure.columns.reduce((peak, column) => (column.amountMinor > peak.amountMinor ? column : peak), exposure.columns[0]!);
  return tallest.currency;
}

/** A small tile that follows the selected column, clamped inside the chart. */
function Tooltip({ fraction, children }: { fraction: number; children: React.ReactNode }) {
  return (
    <div className="pointer-events-auto absolute top-0 z-10 w-[220px] -translate-x-1/2" style={{ left: `clamp(110px, calc(${AXIS}px + (100% - ${AXIS}px) * ${fraction}), calc(100% - 110px))` }}>
      <div className="tile rounded-[18px]! p-3.5 text-fg">{children}</div>
    </div>
  );
}

function Gridlines({ labels }: { labels: { at: number; text: string }[] }) {
  return (
    <>
      {labels.map(({ at, text }) => (
        <div key={at} className="absolute inset-x-0 flex items-center gap-2.5" style={{ top: `${(1 - at) * 100}%` }}>
          <span className="readout w-[46px] shrink-0 -translate-y-px text-right text-[10px] text-fg/40">{text}</span>
          <span className={`h-px flex-1 ${at === 0 ? "bg-fg/20" : "border-t border-dashed border-fg/10"}`} />
        </div>
      ))}
    </>
  );
}

/** One capsule per incident, oldest on the left, scaled to the largest amount on the board. */
export function ValueChart({ exposure }: { exposure: Exposure }) {
  const [active, setActive] = useState<number | null>(null);
  const currency = axisCurrency(exposure);
  const column = active === null ? null : exposure.columns[active]!;
  const labels = [1, 0.5, 0].map((at) => ({ at, text: at === 0 ? "0" : money(Math.round(exposure.maxMinor * at), currency).replace(/\.00$/, "") }));

  return (
    <figure className="relative flex h-full min-h-0 flex-col" aria-label="Amount per incident" onMouseLeave={() => setActive(null)}>
      <div className="relative min-h-0 flex-1">
        <Gridlines labels={labels} />
        <div className="absolute inset-0 flex items-end" style={{ paddingLeft: AXIS }}>
          {exposure.columns.map((item, index) => {
            const height = Math.max(5, (item.amountMinor / exposure.maxMinor) * 92);
            const color = BAND_STYLE[item.band].color;
            const on = active === index;
            return (
              <button
                key={item.id}
                type="button"
                onMouseEnter={() => setActive(index)}
                onFocus={() => setActive(index)}
                onClick={() => setActive(index)}
                aria-label={`${item.reference}, ${money(item.amountMinor, item.currency)}, ${STATUS_CHIP[item.status].label}`}
                className="group relative flex h-full min-w-0 flex-1 cursor-pointer items-end justify-center outline-none"
              >
                {on ? <span aria-hidden className="absolute inset-y-0 left-1/2 border-l border-dashed border-fg/30" /> : null}
                <span
                  className="relative w-[clamp(8px,30%,18px)] rounded-full transition-opacity group-focus-visible:ring-2 group-focus-visible:ring-accent"
                  style={{ height: `${height}%`, background: `linear-gradient(180deg, ${color} 0%, ${tint(color, 70)} 55%, ${tint(color, 18)} 100%)`, opacity: active === null || on ? 1 : 0.4 }}
                >
                  <span aria-hidden className="absolute left-1/2 top-[3px] size-1.5 -translate-x-1/2 rounded-full bg-canvas/90" />
                </span>
              </button>
            );
          })}
        </div>

        {column ? (
          <Tooltip fraction={(active! + 0.5) / exposure.columns.length}>
            <div className="flex items-center justify-between gap-3">
              <span className="readout text-[12px] text-fg/70">{column.reference}</span>
              <span className="size-2 rounded-full" style={{ background: BAND_STYLE[column.band].color }} />
            </div>
            <p className="readout mt-2 text-[20px] font-medium leading-none">{money(column.amountMinor, column.currency)}</p>
            <p className="mt-2 text-[12px] text-fg/65">
              {STATUS_CHIP[column.status].label}
              {column.note ? ` · ${column.note}` : ""}
            </p>
            <p suppressHydrationWarning className="mt-0.5 text-[11.5px] text-fg/45">
              {column.method} rail · moved {ago(column.updatedAt)}
            </p>
            <Link href={`/incidents/${column.id}`} className="mt-2.5 inline-flex text-[12px] font-medium text-accent hover:underline">
              Open the incident →
            </Link>
          </Tooltip>
        ) : null}
      </div>
      <figcaption className="mt-2 flex shrink-0" style={{ paddingLeft: AXIS }}>
        {exposure.columns.map((item, index) => (
          <span key={item.id} className={`readout min-w-0 flex-1 truncate text-center text-[9.5px] ${active === index ? "text-fg" : "text-fg/40"}`}>
            {item.reference.replace(/^[A-Z]+-/, "")}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

/** Ledger events over the window, one slim capsule per bucket, stacked by kind. */
export function ActivityChart({ activity }: { activity: Activity }) {
  const [active, setActive] = useState<number | null>(null);
  if (activity.empty) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1.5 text-center">
        <p className="text-[14px] font-medium">A quiet window</p>
        <p className="max-w-sm text-[12.5px] leading-relaxed text-fg/55">Load the board or set the agent to work, and the ledger's rhythm fills this in.</p>
      </div>
    );
  }
  const counts = (index: number) => activity.ticks[index]!.counts;
  const sumOf = (index: number) => BANDS.reduce((sum, band) => sum + counts(index)[band], 0);
  const top = activity.max;
  const labels = [1, 0.5, 0].map((at) => ({ at, text: at === 0 ? "0" : String(Math.round(top * at)) }));

  return (
    <figure className="relative flex h-full min-h-0 flex-col" aria-label="Ledger events over time" onMouseLeave={() => setActive(null)}>
      <div className="relative min-h-0 flex-1">
        <Gridlines labels={labels} />
        <div className="absolute inset-0 flex items-end gap-[3px]" style={{ paddingLeft: AXIS }}>
          {activity.ticks.map((tick, index) => {
            const sum = sumOf(index);
            const on = active === index;
            return (
              <button
                key={tick.at}
                type="button"
                onMouseEnter={() => setActive(index)}
                onFocus={() => setActive(index)}
                onClick={() => setActive(index)}
                aria-label={`${clockLabel(tick.at)}, ${sum} event${sum === 1 ? "" : "s"}`}
                className="relative flex h-full min-w-[3px] flex-1 cursor-pointer flex-col items-center justify-end outline-none"
              >
                {on ? <span aria-hidden className="absolute inset-y-0 left-1/2 border-l border-dashed border-fg/30" /> : null}
                <span className="relative flex w-[clamp(3px,55%,12px)] flex-col justify-end overflow-hidden rounded-full" style={{ height: `${Math.max(sum === 0 ? 2 : 6, (sum / top) * 92)}%` }}>
                  {sum === 0 ? <span className="h-full w-full bg-fg/15" /> : null}
                  {(["agent", "person", "held", "proof", "moved"] as const).map((band: Band) =>
                    tick.counts[band] > 0 ? (
                      <span key={band} className="w-full" style={{ height: `${(tick.counts[band] / Math.max(1, sum)) * 100}%`, background: BAND_STYLE[band].color, opacity: active === null || on ? 1 : 0.4 }} />
                    ) : null,
                  )}
                </span>
              </button>
            );
          })}
        </div>
        {active !== null ? (
          <Tooltip fraction={(active + 0.5) / activity.ticks.length}>
            <p className="readout text-[12px] text-fg/70">{clockLabel(activity.ticks[active]!.at)}</p>
            <ul className="mt-2 space-y-1">
              {BANDS.map((band) =>
                counts(active)[band] > 0 ? (
                  <li key={band} className="flex items-center justify-between gap-3 text-[12px]">
                    <span className="flex items-center gap-2 text-fg/65">
                      <span className="size-2 rounded-full" style={{ background: BAND_STYLE[band].color }} />
                      {BAND_STYLE[band].label}
                    </span>
                    <span className="readout">{counts(active)[band]}</span>
                  </li>
                ) : null,
              )}
            </ul>
            {sumOf(active) === 0 ? <p className="mt-1 text-[12px] text-fg/55">Nothing stirred in this interval.</p> : null}
          </Tooltip>
        ) : null}
      </div>
      <figcaption className="readout mt-2 flex shrink-0 justify-between text-[9.5px] text-fg/40" style={{ paddingLeft: AXIS }}>
        <span>{clockLabel(activity.ticks[0]!.at)}</span>
        <span>now</span>
      </figcaption>
    </figure>
  );
}

export function Legend({ bands = BANDS }: { bands?: readonly Band[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-3.5 gap-y-1">
      {bands.map((band) => (
        <li key={band} className="flex items-center gap-1.5 text-[11px] text-fg/60">
          <span className="size-2 rounded-full" style={{ background: BAND_STYLE[band].color }} />
          {BAND_STYLE[band].label}
        </li>
      ))}
    </ul>
  );
}
