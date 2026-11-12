"use client";

import Link from "next/link";
import { useState } from "react";
import { money } from "@/lib/format";
import { STATUS } from "@/lib/status";
import { ago } from "@/lib/format";
import { BAND_STYLE, clockLabel, type Activity, type Exposure } from "@/lib/activity";
import { Label } from "../ui";

/**
 * The two charts. Both are drawn with DOM columns rather than SVG, so a bar stays crisp at any width and every column
 * is a real focusable button: hovering, tabbing or clicking says what that one thing is.
 */

const GUTTER = 74;

/** The axis of a value chart needs an amount and a currency; the tallest column on the board supplies both. */
function axisCurrency(exposure: Exposure): string {
  const tallest = exposure.columns.reduce((peak, column) => (column.amountMinor > peak.amountMinor ? column : peak), exposure.columns[0]!);
  return tallest.currency;
}

/** A card that follows the selected column: clamped into the plot, so it never hangs off the panel. */
function Tooltip({ fraction, height, children }: { fraction: number; height: number; children: React.ReactNode }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute z-10 w-[236px] -translate-x-1/2"
      style={{
        left: `clamp(122px, calc(${GUTTER}px + (100% - ${GUTTER + 24}px) * ${fraction}), calc(100% - 122px))`,
        bottom: `min(calc(${height}% + 10px), 44%)`,
      }}
    >
      <div className="hairline rounded-2xl border bg-[#070b17]/95 p-3.5 shadow-[0_18px_50px_-24px_rgb(0_0_0/0.9)] backdrop-blur-md">{children}</div>
    </div>
  );
}

/** One column per incident, oldest on the left, scaled to the largest amount on the board. */
export function ValueChart({ exposure }: { exposure: Exposure }) {
  const [active, setActive] = useState<number | null>(null);
  const currency = axisCurrency(exposure);
  const tick = (fraction: number) => money(Math.round(exposure.maxMinor * fraction), currency);
  const column = active === null ? null : exposure.columns[active]!;

  return (
    <figure className="relative" aria-label="Amount per incident">
      <div className="relative h-[268px]">
        {[1, 0.75, 0.5, 0.25, 0].map((fraction) => (
          <div key={fraction} className="absolute inset-x-0 flex items-center gap-3" style={{ top: `${(1 - fraction) * 100}%` }}>
            <span className="tnum w-[62px] shrink-0 text-right text-[10.5px] text-white/45">{fraction === 0 ? "0" : tick(fraction)}</span>
            <span className={`h-px flex-1 ${fraction === 0 ? "bg-white/20" : "bg-white/[0.09]"}`} />
          </div>
        ))}

        <div className="absolute inset-y-0 left-0 right-0 flex items-end gap-2 pl-[86px]">
          {exposure.columns.map((item, index) => {
            const height = Math.max(3, (item.amountMinor / exposure.maxMinor) * 100);
            const color = BAND_STYLE[item.band].color;
            const on = active === index;
            return (
              <button
                key={item.id}
                type="button"
                onMouseEnter={() => setActive(index)}
                onMouseLeave={() => setActive((current) => (current === index ? null : current))}
                onFocus={() => setActive(index)}
                onClick={() => setActive(index)}
                aria-label={`${item.reference}, ${money(item.amountMinor, item.currency)}, ${STATUS[item.status].label}`}
                style={{ height: `${height}%` }}
                className="group relative min-w-[10px] max-w-[72px] flex-1 cursor-pointer rounded-t-md outline-none"
              >
                <span
                  className="absolute inset-0 rounded-t-md transition-[filter,opacity] group-hover:brightness-110"
                  style={{ background: `linear-gradient(180deg, ${color} 0%, ${color}55 100%)`, opacity: active === null || on ? 1 : 0.55 }}
                />
                <span className={`absolute -top-1 left-0 right-0 h-px rounded-full ${on ? "bg-white" : "bg-transparent"}`} />
              </button>
            );
          })}
        </div>

        {column ? (
          <Tooltip
            fraction={(active! + 0.5) / exposure.columns.length}
            height={Math.max(3, (column.amountMinor / exposure.maxMinor) * 100)}
          >
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-[12px] text-soft">{column.reference}</span>
              <span className={`size-2 rounded-full`} style={{ background: BAND_STYLE[column.band].color }} />
            </div>
            <p className="tnum mt-2 text-[19px] font-medium leading-none">{money(column.amountMinor, column.currency)}</p>
            <p className="mt-2 text-[12px] text-muted">
              {STATUS[column.status].label}
              {column.note ? ` · ${column.note}` : ""}
            </p>
            <p suppressHydrationWarning className="mt-1 text-[11.5px] text-muted">
              {column.method} · moved {ago(column.updatedAt)}
            </p>
            <Link href={`/incidents/${column.id}`} className="mt-2.5 inline-flex text-[12px] text-sky underline decoration-white/20 underline-offset-4 hover:text-white">
              Open the incident
            </Link>
          </Tooltip>
        ) : null}
      </div>

      <figcaption className="mt-3 flex gap-2 pl-[86px]">
        {exposure.columns.map((item, index) => (
          <span key={item.id} className={`min-w-0 flex-1 max-w-[72px] truncate font-mono text-[10px] ${active === index ? "text-white" : "text-white/45"}`}>
            {item.reference.replace(/^[A-Z]+-/, "")}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

/** Ledger events over the window, one thin column per bucket, stacked by band. */
export function ActivityChart({ activity, tickMs, tall = false }: { activity: Activity; tickMs: number; tall?: boolean }) {
  const [active, setActive] = useState<number | null>(null);
  const total = (index: number) => activity.ticks[index]!.counts;

  if (activity.empty) {
    return (
      <div className={`flex ${tall ? "h-[268px]" : "h-[112px]"} flex-col items-center justify-center gap-2 text-center`}>
        <p className="text-[13.5px] text-soft">Nothing has happened in this window yet</p>
        <p className="max-w-sm text-[12.5px] text-muted">
          Load the incidents or run the agent and the ledger fills this chart: money moved, refusals, handoffs to a person, certifications.
        </p>
      </div>
    );
  }

  return (
    <figure className={`relative ${tall ? "h-[268px]" : "h-[112px]"}`} aria-label="Ledger events over time">
      <div className="relative h-full">
        <span className="absolute inset-x-0 top-0 h-px bg-white/[0.09]" />
        <div className="absolute inset-0 flex items-end gap-[3px]">
          {activity.ticks.map((tick, index) => {
            const sum = Object.values(tick.counts).reduce((a, b) => a + b, 0);
            const on = active === index;
            return (
              <button
                key={tick.at}
                type="button"
                onMouseEnter={() => setActive(index)}
                onFocus={() => setActive(index)}
                onClick={() => setActive(index)}
                aria-label={`${clockLabel(tick.at)}, ${sum} event${sum === 1 ? "" : "s"}`}
                className="group relative flex h-full min-w-[3px] flex-1 cursor-pointer flex-col justify-end outline-none"
              >
                <span className="flex w-full flex-col justify-end" style={{ height: `${Math.max(sum === 0 ? 0.6 : 4, (sum / activity.max) * 100)}%` }}>
                  {(["agent", "person", "moved", "held", "proof"] as const).map((band) =>
                    tick.counts[band] > 0 ? (
                      <span
                        key={band}
                        className="w-full first:rounded-t-[3px]"
                        style={{ height: `${(tick.counts[band] / Math.max(1, sum)) * 100}%`, background: BAND_STYLE[band].color, opacity: active === null || on ? 1 : 0.5 }}
                      />
                    ) : null,
                  )}
                </span>
              </button>
            );
          })}
        </div>

        {active !== null ? (
          <div
            className="pointer-events-none absolute z-10 w-[210px] -translate-x-1/2"
            style={{ left: `${((active + 0.5) / activity.ticks.length) * 100}%`, top: 4 }}
          >
            <div className="hairline rounded-2xl border bg-[#070b17]/95 p-3 shadow-[0_18px_50px_-24px_rgb(0_0_0/0.9)] backdrop-blur-md">
              <p className="text-[12px] text-soft">{clockLabel(activity.ticks[active]!.at)}</p>
              <ul className="mt-2 space-y-1">
                {(["moved", "held", "person", "proof", "agent"] as const).map((band) =>
                  total(active)[band] > 0 ? (
                    <li key={band} className="flex items-center justify-between gap-3 text-[12px]">
                      <span className="flex items-center gap-2 text-muted">
                        <span className="size-2 rounded-full" style={{ background: BAND_STYLE[band].color }} />
                        {BAND_STYLE[band].label}
                      </span>
                      <span className="tnum">{total(active)[band]}</span>
                    </li>
                  ) : null,
                )}
              </ul>
              {Object.values(total(active)).every((count) => count === 0) ? <p className="mt-1 text-[12px] text-muted">nothing happened in this minute</p> : null}
            </div>
          </div>
        ) : null}
      </div>

      <figcaption className="absolute -bottom-1 inset-x-0 flex justify-between text-[10px] text-white/40">
        <span>{clockLabel(activity.ticks[0]!.at)}</span>
        {tall ? <span>{tickMs >= 3_600_000 ? "one column per hour" : tickMs >= 60_000 ? "one column per minute" : "one column per tick"}</span> : null}
        <span>now</span>
      </figcaption>
    </figure>
  );
}

/** The band legend, shared by both charts. */
export function Legend({ bands = ["moved", "held", "person", "proof", "agent"] as const }: { bands?: readonly (keyof typeof BAND_STYLE)[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {bands.map((band) => (
        <li key={band} className="flex items-center gap-2">
          <span className="size-2 rounded-full" style={{ background: BAND_STYLE[band].color }} />
          <Label className="text-[11.5px] text-white/70">{BAND_STYLE[band].label}</Label>
        </li>
      ))}
    </ul>
  );
}
