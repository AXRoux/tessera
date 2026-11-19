"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { CaseStep } from "../../../src/server/wire";
import { ago, money } from "@/lib/format";
import { SUPPLIER_PLACES } from "@/lib/supplier-places";
import { useNow } from "@/lib/use-now";
import { LinkBtn } from "../kit/metal";
import { Toggle } from "../kit/widgets";
import { Icon } from "../landing/icons";
import { SupplierMark } from "../suppliers/supplier-mark";
import { ACTOR, bankWords, pillTone, STATE_WORDS, Who, type Lane } from "./case-kit";
import { InvestigationReport } from "../console/investigation";

/** A supplier's mark as a round avatar, with a small badge for what just happened and a dot for where its case stands. */
function Avatar({ lane, step, size = 34 }: { lane: Lane; step?: CaseStep; size?: number }) {
  return (
    <span className="relative shrink-0" style={{ width: size, height: size }}>
      <span className="flex size-full items-center justify-center overflow-hidden rounded-full ring-1 ring-fg/10">
        {lane.supplier ? <SupplierMark supplier={lane.supplier} size={size} /> : null}
      </span>
      {step ? (
        <span className={`absolute -bottom-0.5 -left-1 flex size-[17px] items-center justify-center rounded-full ring-2 ring-[var(--tile-top)] ${pillTone(step)} bg-[var(--tile-top)]`}>
          <span className={`flex size-full items-center justify-center rounded-full ${pillTone(step)}`}>
            <Who step={step} lane={lane} size={11} />
          </span>
        </span>
      ) : null}
      <span aria-hidden className={`absolute -bottom-px -right-px size-[11px] rounded-full ring-2 ring-[var(--tile-top)] ${STATE_WORDS[lane.case.outcome.state].dot}`} />
    </span>
  );
}

/**
 * One supplier's issue, opened from its pin: who and where, the problem, and either the case (invoice, amount, the bank,
 * where it landed, what is left for you) or the trail (every move, newest first).
 */
export function SupplierCard({ lane, onClose, className = "" }: { lane: Lane; onClose: () => void; className?: string }) {
  const [tab, setTab] = useState<"case" | "trail">("case");
  useNow(5000);
  const c = lane.case;
  const state = STATE_WORDS[c.outcome.state];
  const place = lane.supplier ? SUPPLIER_PLACES[lane.supplier.id] : undefined;
  const steps = [...c.steps].reverse();

  return (
    <article className={`tile rise flex min-h-0 flex-col overflow-hidden rounded-[22px]! [animation-duration:0.35s] ${className}`} aria-label={`${lane.supplier?.name ?? lane.reference}: its case`}>
      <header className="flex shrink-0 items-start gap-3 px-4 pt-4">
        <Avatar lane={lane} size={42} />
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate text-[15px] font-semibold tracking-[-0.01em]">{lane.supplier?.name ?? lane.reference}</span>
            {place ? <span className="truncate text-[12.5px] text-fg/50">{place.city}</span> : null}
          </p>
          <p className="mt-0.5 flex items-center gap-1.5 text-[12.5px]">
            <span className={`font-medium ${state.text}`}>{state.word}</span>
            <span className="readout text-[11px] text-fg/40">· {lane.reference}</span>
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="-mr-1 -mt-1 flex size-8 cursor-pointer items-center justify-center rounded-full text-fg/50 hover:bg-fg/[0.06] hover:text-fg">
          <Icon name="close" className="size-4" />
        </button>
      </header>

      <div className="mx-4 mt-3 shrink-0 rounded-[14px] bg-bad/[0.08] px-3 py-2.5 ring-1 ring-inset ring-bad/25">
        <p className="text-[13px] font-semibold leading-snug text-bad">{c.problem.headline}</p>
        <p className="mt-1 text-[12px] leading-snug text-fg/60">{c.problem.detail}</p>
      </div>

      <div className="mt-3 shrink-0 px-4">
        <Toggle
          label="Show"
          value={tab}
          onChange={setTab}
          className="w-full [&>button]:flex-1 [&>button]:justify-center"
          options={[
            { id: "case", label: "Case" },
            { id: "trail", label: "Trail", count: c.steps.length },
          ]}
        />
      </div>

      <div className="thin-scroll mt-3 min-h-0 flex-1 overflow-y-auto px-4 pb-3">
        {tab === "case" ? (
          <div className="space-y-3">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 border-b border-fg/[0.08] pb-3">
              {(
                [
                  ["Invoice", lane.reference],
                  ["Amount", money(lane.amountMinor, lane.currency)],
                  ["At Airwallex", bankWords(lane)],
                  ["Headquarters", place ? `${place.address}${place.precision === "city" ? " (city)" : ""}` : "Not on the map"],
                ] as const
              ).map(([term, value]) => (
                <div key={term} className={`min-w-0 ${term === "Headquarters" ? "col-span-2" : ""}`} title={term === "Headquarters" ? place?.source : undefined}>
                  <dt className="text-[11.5px] text-fg/45">{term}</dt>
                  <dd className="mt-0.5 truncate text-[13px] font-medium" title={value}>
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
            {c.investigation ? (
              <div className="border-b border-fg/[0.08] pb-3">
                <p className="mb-2 text-[11.5px] text-fg/45">What the investigation found</p>
                <InvestigationReport found={c.investigation} compact />
              </div>
            ) : null}
            <div>
              <p className="text-[11.5px] text-fg/45">Where it landed</p>
              <p className={`mt-0.5 text-[13.5px] font-semibold leading-snug ${state.text}`}>{c.outcome.headline}</p>
              {c.outcome.detail ? <p className="mt-0.5 text-[12.5px] leading-snug text-fg/60">{c.outcome.detail}</p> : null}
            </div>
            {c.outcome.yours ? (
              <div className="space-y-2 rounded-[14px] bg-warn/[0.09] px-3 py-2.5 ring-1 ring-inset ring-warn/30">
                <p className="flex items-start gap-1.5 text-[12.5px] leading-snug text-warn">
                  <Icon name="hand" className="mt-px size-3.5 shrink-0" />
                  {c.outcome.yours}
                </p>
                <LinkBtn href={`/queue?id=${lane.id}`} size="sm">
                  Take it over
                </LinkBtn>
              </div>
            ) : null}
          </div>
        ) : (
          <ol className="space-y-2.5">
            {steps.length === 0 ? <li className="text-[12.5px] text-fg/45">No move yet. Let the agent work it.</li> : null}
            {steps.map((step) => (
              <li key={step.seq} className="flex gap-2.5">
                <span className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full ring-1 ring-inset ${pillTone(step)}`}>
                  <Who step={step} lane={lane} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[12.5px] font-semibold">
                      {step.label}
                      {step.count > 1 ? <span className="readout font-normal text-fg/45"> ×{step.count}</span> : null}
                    </span>
                    <span suppressHydrationWarning className="shrink-0 text-[11px] text-fg/40">
                      {ago(step.at)}
                    </span>
                  </p>
                  <p className="mt-0.5 text-[12px] leading-snug text-fg/60">
                    <span className="text-fg/45">{ACTOR[step.actor]} · </span>
                    {step.text}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>

      <footer className="shrink-0 border-t border-fg/[0.08] px-4 py-2.5">
        <Link href={`/incidents/${lane.id}`} className="inline-flex items-center gap-1 text-[12.5px] font-medium text-accent hover:underline">
          Open {lane.reference} and its evidence
          <Icon name="arrow" className="size-3.5" />
        </Link>
      </footer>
    </article>
  );
}

/** Every move on every issue, newest first, each with the lane it belongs to. */
function moves(lanes: Lane[]): Array<{ lane: Lane; step: CaseStep }> {
  return lanes.flatMap((lane) => lane.case.steps.map((step) => ({ lane, step }))).sort((a, b) => b.step.seq - a.step.seq);
}

function MoveRow({ lane, step, onPick, time }: { lane: Lane; step: CaseStep; onPick: () => void; time: "ago" | "clock" }) {
  return (
    <li>
      <button type="button" onClick={onPick} className="flex w-full cursor-pointer items-start gap-3 rounded-[14px] px-2 py-2 text-left transition-colors hover:bg-fg/[0.05]">
        <Avatar lane={lane} step={step} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="truncate text-[13px] font-semibold">{lane.supplier?.name ?? lane.reference}</span>
            <span suppressHydrationWarning className="shrink-0 text-[11.5px] text-fg/45">
              {time === "ago" ? ago(step.at) : new Date(step.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            </span>
          </span>
          <span className="mt-0.5 block truncate text-[12px] text-fg/60" title={step.text}>
            {ACTOR[step.actor]} · {step.label}
            {step.count > 1 ? ` ×${step.count}` : ""}
            <span className="readout text-[11px] text-fg/40"> · {lane.reference}</span>
          </span>
        </span>
      </button>
    </li>
  );
}

/** The latest moves across every supplier, as they land: the agent's, a person's, the bank's. Folds to its header. */
export function LiveActivity({ lanes, running, onPick, onAll, className = "" }: { lanes: Lane[]; running: boolean; onPick: (id: string) => void; onAll: () => void; className?: string }) {
  const now = useNow(5000);
  const [open, setOpen] = useState(true);
  const all = useMemo(() => moves(lanes), [lanes]);
  const recent = all.filter((m) => now - Date.parse(m.step.at) < 30 * 60_000).length;
  return (
    <section aria-label="Live activity" className={`tile overflow-hidden rounded-[22px]! ${className}`}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full cursor-pointer items-center justify-between gap-2 px-4 py-3">
        <span className="flex items-center gap-2">
          <span aria-hidden className={`size-2 rounded-full bg-ok ${running ? "beat" : ""}`} />
          <span className="text-[13.5px] font-semibold">Live activity</span>
          <span className="text-[12px] text-fg/45">
            {recent} {recent === 1 ? "move" : "moves"} in 30 min
          </span>
        </span>
        <Icon name="chevron" className={`size-4 text-fg/50 transition-transform ${open ? "" : "rotate-180"}`} />
      </button>
      {open ? (
        <>
          <ol className="px-2 short:[&>li:nth-child(3)]:hidden">
            {all.length === 0 ? <li className="px-2 pb-3 text-[12.5px] text-fg/45">No moves yet. Let the agent work the issues.</li> : null}
            {all.slice(0, 3).map(({ lane, step }) => (
              <MoveRow key={`${lane.id}-${step.seq}`} lane={lane} step={step} time="ago" onPick={() => onPick(lane.id)} />
            ))}
          </ol>
          {all.length > 0 ? (
            <button type="button" onClick={onAll} className="flex w-full cursor-pointer items-center justify-center gap-1 border-t border-fg/[0.08] py-2.5 text-[12.5px] font-medium text-fg/80 hover:text-fg">
              See all activity
              <Icon name="chevron" className="size-3.5 -rotate-90" />
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

type Who = "all" | "agent" | "people" | "banks";
const WHO: Record<Who, (step: CaseStep) => boolean> = {
  all: () => true,
  agent: (s) => s.actor === "agent" || s.actor === "test",
  people: (s) => s.actor === "you" || s.actor === "supplier",
  banks: (s) => s.actor === "airwallex" || s.actor === "visa" || s.actor === "tessera",
};

/** Every move on every supplier issue, newest first and grouped by the hour. A click opens that supplier on the map. */
export function ActivityHistory({ lanes, onPick, onClose }: { lanes: Lane[]; onPick: (id: string) => void; onClose: () => void }) {
  const [who, setWho] = useState<Who>("all");
  const all = useMemo(() => moves(lanes), [lanes]);
  const shown = all.filter((m) => WHO[who](m.step));
  const groups: Array<{ hour: string; items: typeof shown }> = [];
  for (const m of shown) {
    const hour = new Date(m.step.at).toLocaleTimeString([], { hour: "numeric" });
    const last = groups.at(-1);
    if (last && last.hour === hour) last.items.push(m);
    else groups.push({ hour, items: [m] });
  }
  return (
    <div className="absolute inset-0 z-30 flex items-start justify-center bg-canvas/40 p-3 backdrop-blur-[3px]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section role="dialog" aria-label="Activity history" className="tile rise flex max-h-full w-full max-w-[560px] flex-col overflow-hidden rounded-[24px]! [animation-duration:0.3s]">
        <header className="flex shrink-0 items-start justify-between gap-3 px-5 pt-5">
          <div>
            <h3 className="text-[17px] font-semibold tracking-[-0.02em]">Activity history</h3>
            <p className="mt-1 text-[12.5px] text-fg/55">Every move on these supplier issues, newest first. Click one to open its supplier.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-fg/50 hover:bg-fg/[0.06] hover:text-fg">
            <Icon name="close" className="size-4" />
          </button>
        </header>
        <div className="mt-3 shrink-0 px-5">
          <Toggle
            label="Who moved"
            value={who}
            onChange={setWho}
            options={[
              { id: "all", label: "Everyone", count: all.length },
              { id: "agent", label: "Agent", count: all.filter((m) => WHO.agent(m.step)).length },
              { id: "people", label: "People", count: all.filter((m) => WHO.people(m.step)).length },
              { id: "banks", label: "Banks", count: all.filter((m) => WHO.banks(m.step)).length },
            ]}
          />
        </div>
        <div className="thin-scroll mt-3 min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          {groups.length === 0 ? <p className="px-2 py-6 text-center text-[12.5px] text-fg/45">Nothing yet.</p> : null}
          {groups.map((group, i) => (
            <div key={`${group.hour}-${i}`}>
              <p suppressHydrationWarning className="px-2 pb-1 pt-2 text-[11.5px] font-semibold text-fg/45">
                {group.hour}
              </p>
              <ol>
                {group.items.map(({ lane, step }) => (
                  <MoveRow
                    key={`${lane.id}-${step.seq}`}
                    lane={lane}
                    step={step}
                    time="clock"
                    onPick={() => {
                      onPick(lane.id);
                      onClose();
                    }}
                  />
                ))}
              </ol>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
