"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { IncidentSummary, IncidentView } from "../../../src/server/wire";
import { Inverted } from "./theme";

/*
 * The widget vocabulary of the control room, after the reference: gauges with a dotted tail, stadium meters, a rounded
 * square ring, mono readouts set in recessed wells, segmented bars, dot matrices and a battery. Everything draws in
 * `currentColor` or a palette variable, so one component serves both themes and the inverted tile.
 */

export type ChipTone = "accent" | "warn" | "bad" | "solid" | "neutral";

const STROKE: Record<ChipTone, string> = {
  accent: "text-accent",
  warn: "text-warn",
  bad: "text-bad",
  solid: "text-fg",
  neutral: "text-fg/45",
};

/* ── Surfaces ───────────────────────────────────────────────────────────────────────────────────────────────────── */

/** A frosted tray: the rail a group of widgets sits in. */
export function Tray({ children, className = "", label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <section aria-label={label} className={`tray flex min-h-0 min-w-0 flex-col ${className}`}>
      {children}
    </section>
  );
}

/** A squircle tile. `invert` makes it the one dark tile in a light room (or the reverse), and tells metal inside about it. */
export function Tile({ children, className = "", invert = false, as = "div" }: { children: ReactNode; className?: string; invert?: boolean; as?: "div" | "section" | "article" | "li" }) {
  const Tag = as;
  const body = <Tag className={`tile ${invert ? "inverse" : ""} min-w-0 ${className}`}>{children}</Tag>;
  return invert ? <Inverted>{body}</Inverted> : body;
}

/** The tray's title row: a step number in a tiny well, the title, a quiet line, and anything for the right edge. */
export function TrayHead({ n, title, note, right, className = "" }: { n?: number; title: ReactNode; note?: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <header className={`flex shrink-0 items-start justify-between gap-3 ${className}`}>
      <div className="flex min-w-0 items-start gap-2.5">
        {n ? <span className="well readout mt-0.5 flex h-6 shrink-0 items-center rounded-full px-2 text-[10.5px] text-fg/70">{String(n).padStart(2, "0")}</span> : null}
        <div className="min-w-0">
          <h2 className="truncate text-[15px] font-semibold leading-7 tracking-[-0.02em] text-fg">{title}</h2>
          {note ? <p className="truncate text-[12px] leading-snug text-fg/50 short:hidden">{note}</p> : null}
        </div>
      </div>
      {right ? <div className="flex shrink-0 items-center gap-2">{right}</div> : null}
    </header>
  );
}

/* ── Labels and readouts ────────────────────────────────────────────────────────────────────────────────────────── */

export function Kicker({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`kicker block ${className}`}>{children}</span>;
}

/** A clock-style readout in a well. Colons are dimmed, the way a segment display sets them. */
export function Readout({ value, size = "md", className = "" }: { value: string; size?: "sm" | "md" | "lg"; className?: string }) {
  const text = size === "lg" ? "text-[28px] px-4 h-12" : size === "md" ? "text-[20px] px-3.5 h-10" : "text-[13px] px-2.5 h-7";
  return (
    <span className={`well readout inline-flex items-center rounded-full font-medium text-fg ${text} ${className}`}>
      {value.split(/(:)/).map((part, i) =>
        part === ":" ? (
          <span key={i} className="mx-px text-fg/30">
            :
          </span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </span>
  );
}

/** A status pill: a dot and a word, set in a well so it reads as a physical indicator. */
export function Chip({ tone = "neutral", pulse = false, children, className = "" }: { tone?: ChipTone; pulse?: boolean; children: ReactNode; className?: string }) {
  if (tone === "solid") {
    return (
      <span className={`inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-fg px-2.5 text-[11.5px] font-medium text-canvas ${className}`}>
        <span aria-hidden className={`size-1.5 rounded-full bg-canvas ${pulse ? "beat" : ""}`} />
        {children}
      </span>
    );
  }
  return (
    <span className={`well inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[11.5px] font-medium text-fg/85 ${className}`}>
      <span aria-hidden className={`size-1.5 rounded-full bg-current ${STROKE[tone]} ${pulse ? "beat" : ""}`} />
      {children}
    </span>
  );
}

/** A mono line that drifts sideways when it is too long to sit still: what the agent is doing right now. */
export function Ticker({ children, className = "" }: { children: ReactNode; className?: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const [drift, setDrift] = useState(0);
  useLayoutEffect(() => {
    const measure = () => setDrift(Math.max(0, (text.current?.scrollWidth ?? 0) - (box.current?.clientWidth ?? 0)));
    measure();
    const observer = new ResizeObserver(measure);
    if (box.current) observer.observe(box.current);
    return () => observer.disconnect();
  }, [children]);
  return (
    <span ref={box} className={`relative block overflow-hidden whitespace-nowrap [mask-image:linear-gradient(90deg,transparent,#000_6%,#000_94%,transparent)] ${className}`}>
      <span ref={text} className={`readout inline-block px-2 text-[11.5px] text-fg/55 ${drift > 0 ? "drift" : ""}`} style={{ ["--drift" as string]: `-${drift + 16}px` }}>
        {children}
      </span>
    </span>
  );
}

/* ── Meters ─────────────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * A rounded-rectangle outline as one path, starting at the top or bottom centre and running clockwise, so a dash can
 * draw progress around it from a natural starting point. Inset by half the stroke so nothing is clipped.
 */
function outline(w: number, h: number, radius: number, inset: number, start: "top" | "bottom"): string {
  const x0 = inset;
  const y0 = inset;
  const x1 = w - inset;
  const y1 = h - inset;
  const r = Math.min(radius, (x1 - x0) / 2, (y1 - y0) / 2);
  const cx = w / 2;
  const top = `L ${x1 - r} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y0 + r} L ${x1} ${y1 - r} A ${r} ${r} 0 0 1 ${x1 - r} ${y1} L ${x0 + r} ${y1} A ${r} ${r} 0 0 1 ${x0} ${y1 - r} L ${x0} ${y0 + r} A ${r} ${r} 0 0 1 ${x0 + r} ${y0} Z`;
  if (start === "top") return `M ${cx} ${y0} ${top}`;
  return `M ${cx} ${y1} L ${x0 + r} ${y1} A ${r} ${r} 0 0 1 ${x0} ${y1 - r} L ${x0} ${y0 + r} A ${r} ${r} 0 0 1 ${x0 + r} ${y0} L ${x1 - r} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y0 + r} L ${x1} ${y1 - r} A ${r} ${r} 0 0 1 ${x1 - r} ${y1} Z`;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));

/** The 270° gauge with a dotted tail: a reading, its arc, and up to five discrete marks under it. */
export function Gauge({
  value,
  tone = "solid",
  dots,
  size = 96,
  className,
  children,
  label,
}: {
  value: number;
  tone?: ChipTone;
  /** Discrete marks in the gap: [filled, total]. */
  dots?: [number, number];
  size?: number;
  /** Size it with classes instead (responsive); overrides `size`. */
  className?: string;
  children?: ReactNode;
  label: string;
}) {
  const r = 40;
  const c = 2 * Math.PI * r;
  const arc = 0.75 * c;
  const v = clamp01(value);
  return (
    <div role="img" aria-label={label} className={`relative shrink-0 ${className ?? ""}`} style={className ? undefined : { width: size, height: size }}>
      <svg viewBox="0 0 100 100" className="absolute inset-0 size-full rotate-[135deg]">
        <circle cx="50" cy="50" r={r} fill="none" stroke="var(--track)" strokeWidth="7" strokeLinecap="round" strokeDasharray={`${arc} ${c}`} />
        {v > 0 ? (
          <circle
            cx="50"
            cy="50"
            r={r}
            fill="none"
            stroke="currentColor"
            strokeWidth="7"
            strokeLinecap="round"
            strokeDasharray={`${arc * v} ${c}`}
            className={`${STROKE[tone]} transition-[stroke-dasharray] duration-700`}
          />
        ) : null}
      </svg>
      {dots ? (
        <span aria-hidden className="absolute inset-x-0 bottom-[7%] flex justify-center gap-[5%]">
          {Array.from({ length: dots[1] }, (_, i) => (
            <span key={i} className={`size-[7%] rounded-full ${i < dots[0] ? "bg-fg" : "bg-fg/25"}`} />
          ))}
        </span>
      ) : null}
      <div className="absolute inset-0 flex flex-col items-center justify-center pb-[6%]">{children}</div>
    </div>
  );
}

/** The stadium meter: progress run clockwise around a capsule outline from its lower edge, content inside. */
export function Capsule({ value, tone = "solid", width = 168, height = 60, stroke = 6, children, label }: { value: number; tone?: ChipTone; width?: number; height?: number; stroke?: number; children?: ReactNode; label: string }) {
  const d = outline(width, height, height / 2, stroke / 2, "bottom");
  const v = clamp01(value);
  return (
    <div role="img" aria-label={label} className="relative shrink-0" style={{ width, height }}>
      <svg viewBox={`0 0 ${width} ${height}`} className="absolute inset-0 size-full">
        <path d={d} fill="none" stroke="var(--track)" strokeWidth={stroke} strokeLinecap="round" pathLength={100} />
        {v > 0 ? <path d={d} fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" pathLength={100} strokeDasharray={`${v * 100} 100`} className={STROKE[tone]} /> : null}
      </svg>
      <div className="absolute inset-0 flex items-center justify-between px-[16%]">{children}</div>
    </div>
  );
}

/** The rounded-square ring around an icon: the reference's lightning tile. Progress starts at the top centre. */
export function RingSquare({ value, tone = "accent", size = 88, children, spinning = false }: { value: number; tone?: ChipTone; size?: number; children: ReactNode; spinning?: boolean }) {
  const d = outline(100, 100, 30, 4, "top");
  const v = clamp01(value);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" className="absolute inset-0 size-full">
        <path d={d} fill="none" stroke="var(--track)" strokeWidth="7" pathLength={100} />
        <path
          d={d}
          fill="none"
          stroke="currentColor"
          strokeWidth="7"
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={spinning ? "28 72" : `${Math.max(0.001, v * 100)} 100`}
          className={`${STROKE[tone]} transition-[stroke-dasharray] duration-700 ${spinning ? "[animation:ring-chase_1.6s_linear_infinite]" : ""}`}
        />
      </svg>
      <div className="tile inverse absolute inset-[16%] flex items-center justify-center rounded-[22%] text-fg">{children}</div>
    </div>
  );
}

/** Segments in one row, the reference's "assets" bar: each a pill sized by its share. */
export function SegBar({ parts, className = "" }: { parts: { value: number; tone: "fg" | "mid" | "accent" | "warn" | "bad"; label: string }[]; className?: string }) {
  const total = parts.reduce((sum, p) => sum + Math.max(0, p.value), 0) || 1;
  const fill = { fg: "bg-fg", mid: "bg-fg/30", accent: "bg-accent", warn: "bg-warn", bad: "bg-bad" } as const;
  return (
    <div className={`flex h-2.5 gap-1 ${className}`} role="img" aria-label={parts.map((p) => `${p.label} ${p.value}`).join(", ")}>
      {parts
        .filter((p) => p.value > 0)
        .map((p) => (
          <span key={p.label} title={p.label} className={`min-w-2.5 rounded-full ${fill[p.tone]}`} style={{ flexGrow: p.value / total, flexBasis: 0 }} />
        ))}
    </div>
  );
}

/** A dot matrix: each cell a state. The reference's grid, used for the board at a glance. */
export function DotMatrix({ cells, cols, className = "" }: { cells: { tone: ChipTone | "off"; title?: string }[]; cols: number; className?: string }) {
  const fill = { accent: "bg-accent", warn: "bg-warn", bad: "bg-bad", solid: "bg-fg", neutral: "bg-fg/35", off: "border border-fg/20" } as const;
  return (
    <div className={`grid gap-[6px] ${className}`} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {cells.map((cell, i) => (
        <span key={i} title={cell.title} className={`aspect-square w-full rounded-full ${fill[cell.tone]}`} />
      ))}
    </div>
  );
}

/** The battery: how much of a window is left, with the time under it. */
export function Battery({ value, tone = "solid", children, label }: { value: number; tone?: ChipTone; children: ReactNode; label: string }) {
  const v = clamp01(value);
  const fill = { accent: "bg-accent", warn: "bg-warn", bad: "bg-bad", solid: "bg-fg", neutral: "bg-fg/40" } as const;
  return (
    <div role="img" aria-label={label} className="flex items-center gap-1">
      <div className="relative h-10 w-[120px] rounded-[14px] border-2 border-fg/25 p-[3px]">
        <div className={`h-full rounded-[10px] transition-[width] duration-700 ${fill[tone]}`} style={{ width: `${Math.max(v * 100, 9)}%` }} />
        <span className={`readout absolute inset-0 flex items-center px-3 text-[14px] font-medium ${v > 0.45 ? "text-canvas" : "text-fg"}`}>{children}</span>
      </div>
      <span className="h-3.5 w-1 rounded-r-full bg-fg/25" />
    </div>
  );
}

/* ── Controls ───────────────────────────────────────────────────────────────────────────────────────────────────── */

/** The segmented toggle from the reference: a recessed track, and the chosen option raised out of it as a tile. */
export function Toggle<T extends string>({
  value,
  options,
  onChange,
  label,
  className = "",
  size = "sm",
}: {
  value: T;
  options: { id: T; label: ReactNode; count?: number; title?: string }[];
  onChange: (next: T) => void;
  label: string;
  className?: string;
  size?: "sm" | "md";
}) {
  const ids = options.map((o) => o.id);
  const move = (delta: number) => onChange(ids[(ids.indexOf(value) + delta + ids.length) % ids.length]!);
  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
          event.preventDefault();
          move(event.key === "ArrowRight" ? 1 : -1);
        }
      }}
      className={`well flex max-w-full shrink-0 items-center gap-0.5 overflow-x-auto rounded-full p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${className}`}
    >
      {options.map((option) => {
        const on = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="tab"
            title={option.title}
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(option.id)}
            className={`inline-flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full font-medium transition-all ${size === "md" ? "h-9 px-4 text-[13px]" : "h-7 px-3 text-[12px]"} ${
              on ? "tile rounded-full! text-fg" : "text-fg/50 hover:text-fg/80"
            }`}
          >
            {option.label}
            {option.count !== undefined ? <span className={`readout text-[10.5px] ${on ? "text-fg/55" : "text-fg/35"}`}>{option.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/* ── Time ───────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** A clock that ticks every second, for countdowns a room can watch. */
export function useTick(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/** "04:14", "1:02:09", or "3d 04h" for something days away. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  if (d > 0) return `${d}d ${two(h)}h`;
  if (h > 0) return `${h}:${two(m)}:${two(s)}`;
  return `${two(m)}:${two(s)}`;
}

/* ── Status, in this palette ────────────────────────────────────────────────────────────────────────────────────── */

export const STATUS_CHIP: Record<IncidentSummary["status"], { label: string; tone: ChipTone; pulse: boolean }> = {
  OPEN: { label: "Open", tone: "neutral", pulse: false },
  PAYING: { label: "In flight", tone: "accent", pulse: true },
  PAID: { label: "Paid", tone: "accent", pulse: false },
  NEEDS_ACTION: { label: "Needs a decision", tone: "warn", pulse: true },
  ESCALATED: { label: "With a person", tone: "warn", pulse: true },
  CLOSED: { label: "Certified", tone: "solid", pulse: false },
};

export const ATTEMPT_CHIP: Record<IncidentView["attempts"][number]["state"], { label: string; tone: ChipTone; pulse: boolean }> = {
  INTENT: { label: "Sealed", tone: "neutral", pulse: true },
  LIVE: { label: "In flight", tone: "accent", pulse: true },
  PAID: { label: "Paid", tone: "solid", pulse: false },
  DEAD: { label: "Cancelled", tone: "bad", pulse: false },
  ABANDONED: { label: "Never sent", tone: "neutral", pulse: false },
};
