"use client";

import { useEffect, useMemo, useState } from "react";
import { IncidentListSchema, type Health, type IncidentSummary } from "../../../src/server/wire";
import { reasonText } from "@/lib/agent-verdict";
import { api } from "@/lib/client-api";
import { ago, money } from "@/lib/format";
import { needsYou } from "@/lib/tour-steps";
import { useIncident } from "@/lib/use-incident";
import { useAgentRun } from "../agent/agent-run";
import { AgentMark } from "../kit/agent-mark";
import { ActionsPanel } from "../console/actions-panel";
import { DecisionPanel } from "../console/decision-panel";
import { NoticeBox } from "../console/fields";
import { ATTENTION } from "../dashboard/queue";
import { Icon } from "../landing/icons";
import { Btn, LinkBtn } from "../kit/metal";
import { Chip, Gauge, Kicker, RingSquare, Tile, Toggle, Tray, TrayHead } from "../kit/widgets";
import { Workspace, useShell } from "../shell";
import { markTakeoverOpened } from "../tour";

type Kind = NonNullable<IncidentSummary["attention"]>["kind"];
type Filter = "all" | Kind;

const WORDS = ["Nothing", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

/** The list, kept current on its own cadence: the queue is the one page where staleness costs a decision. */
function useList(initial: IncidentSummary[]) {
  const [items, setItems] = useState(initial);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden)
        void api("obligations", IncidentListSchema)
          .then((list) => setItems(list.items))
          .catch(() => undefined);
    }, 4000);
    return () => clearInterval(timer);
  }, []);
  return items;
}

function Count({ label, value, of, tone }: { label: string; value: number; of: number; tone: "warn" | "accent" | "neutral" }) {
  return (
    <Tile className="flex items-center gap-3 rounded-[20px]! py-2 pl-2 pr-4">
      <Gauge label={`${label}: ${value}`} value={of > 0 ? value / of : 0} tone={tone} className="size-[52px]">
        <span className="readout text-[15px] font-medium">{value}</span>
      </Gauge>
      <span className="text-[12px] leading-tight text-fg/60">{label}</span>
    </Tile>
  );
}

/**
 * The queue as a workbench, Palantir-style: everything waiting on a person on the left, most urgent first, and the
 * selected one's situation and moves beside it, so a person can work the whole queue without leaving the page.
 * Arrow keys walk the list.
 */
export function QueueRoom({ initial, health, selected }: { initial: IncidentSummary[]; health: Health | null; selected: string | null }) {
  const items = useList(initial);
  const { query } = useShell();
  const agent = useAgentRun();
  const waiting = useMemo(() => needsYou(items), [items]);
  const [filter, setFilter] = useState<Filter>("all");
  const needle = query.trim().toLowerCase();
  const shown = waiting.filter((item) => (filter === "all" || item.attention.kind === filter) && (needle === "" || `${item.reference} ${item.attention.reason}`.toLowerCase().includes(needle)));
  const [pick, setPick] = useState<string | null>(selected);
  const current = shown.find((item) => item.id === pick) ?? shown[0] ?? null;
  const { view, busy, notice, setNotice, run } = useIncident(current?.id ?? null);
  const count = (kind: Kind) => waiting.filter((item) => item.attention.kind === kind).length;

  useEffect(() => {
    if (current) markTakeoverOpened();
  }, [current]);

  // Arrow keys walk the queue, unless the operator is typing a note.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement;
      if (typing || (event.key !== "ArrowDown" && event.key !== "ArrowUp") || shown.length === 0) return;
      event.preventDefault();
      const at = Math.max(0, shown.findIndex((item) => item.id === current?.id));
      setPick(shown[(at + (event.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length]!.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown, current]);

  return (
    <Workspace>
      <div className="flex shrink-0 flex-wrap items-end justify-between gap-4 px-1">
        <div className="min-w-0">
          <Kicker>Queue</Kicker>
          <h1 className="mt-2 text-[clamp(22px,1.9vw,30px)] font-semibold leading-[1.1] tracking-[-0.04em]">
            {waiting.length === 0 ? "The queue is clear." : `${WORDS[waiting.length] ?? waiting.length} ${waiting.length === 1 ? "decision is" : "decisions are"} yours to make.`}
          </h1>
          <p className="mt-1.5 max-w-[620px] text-[13px] leading-snug text-fg/55">
            You are the human in the loop. Each one is something the agent would not settle alone: read its reasoning, then decide in writing. Nothing moves until you do. ↑ and ↓ walk the list.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Count label="Handed to you" value={count("ESCALATED")} of={waiting.length} tone="warn" />
          <Count label="Need a decision" value={count("NEEDS_ACTION")} of={waiting.length} tone="accent" />
          <Count label="Replies to send" value={count("DRAFT")} of={waiting.length} tone="neutral" />
        </div>
      </div>

      <div className="grid min-h-0 gap-4 xl:flex-1 xl:grid-cols-[minmax(320px,380px)_minmax(0,1fr)_minmax(360px,420px)] 2xl:grid-cols-[400px_minmax(0,1fr)_440px]">
        <Tray label="Waiting on you" className="min-h-[420px] gap-3 p-3 xl:min-h-0">
          <TrayHead className="px-2 pt-1" n={1} title="Waiting on you" note="Most urgent first" />
          <div className="shrink-0 px-1">
            <Toggle
              label="Filter the queue"
              value={filter}
              onChange={setFilter}
              options={[
                { id: "all", label: "All", count: waiting.length },
                { id: "ESCALATED", label: "Handed over", count: count("ESCALATED") },
                { id: "NEEDS_ACTION", label: "Decisions", count: count("NEEDS_ACTION") },
                { id: "DRAFT", label: "Replies", count: count("DRAFT") },
              ]}
            />
          </div>
          {shown.length === 0 ? (
            <div className="well flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-[24px]! px-6 text-center">
              <RingSquare value={1} tone="accent" size={76}>
                <Icon name="check" className="size-6" />
              </RingSquare>
              <p className="text-[14px] font-semibold">{waiting.length === 0 ? "Nothing needs you" : "Nothing fits that filter"}</p>
              <p className="max-w-[260px] text-[12px] leading-relaxed text-fg/50">
                {waiting.length === 0 ? "When the agent meets something it should not settle alone, it lands here with its reasoning." : "Try another filter, or clear the search."}
              </p>
            </div>
          ) : (
            <ul className="thin-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-1" role="listbox" aria-label="Incidents waiting on you">
              {shown.map((item) => {
                const on = item.id === current?.id;
                const kind = ATTENTION[item.attention.kind];
                return (
                  <li key={item.id} role="option" aria-selected={on}>
                    <button type="button" onClick={() => setPick(item.id)} className="block w-full cursor-pointer text-left">
                      <Tile className={`rounded-[20px]! px-4 py-3 transition-shadow ${on ? "ring-2 ring-accent" : "hover:ring-1 hover:ring-fg/15"}`}>
                        <span className="flex items-center justify-between gap-3">
                          <span className="flex min-w-0 items-baseline gap-2">
                            <span className="readout truncate text-[13px] font-medium">{item.reference}</span>
                            <span className="readout text-[12px] text-fg/55">{money(item.amountMinor, item.currency)}</span>
                          </span>
                          <Chip tone={kind.tone}>{kind.label}</Chip>
                        </span>
                        <span title={item.attention.reason} className="mt-1.5 line-clamp-2 text-[12px] leading-snug text-fg/60">
                          {reasonText(item.attention.reason)}
                        </span>
                        <span suppressHydrationWarning className="readout mt-2 block text-[10.5px] text-fg/40">
                          {item.method} · moved {ago(item.updatedAt)}
                        </span>
                      </Tile>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Tray>

        <div className="flex min-h-[520px] flex-col xl:min-h-0 [&>*]:flex-1">
          {view && current && view.obligation.id === current.id ? (
            <DecisionPanel view={view} step={2} />
          ) : (
            <Tile className="flex items-center justify-center rounded-[30px]! text-[13px] text-fg/45">{current ? "Reading the incident…" : "Pick something from the queue."}</Tile>
          )}
        </div>

        <Tray label="Your move" className="min-h-[620px] gap-3 p-3 xl:min-h-0">
          <TrayHead
            className="px-2 pt-1"
            n={3}
            title="Your move"
            note={current ? `On ${current.reference}` : "Nothing selected"}
            right={current ? <LinkBtn tone="secondary" href={`/incidents/${current.id}`}>Open in full</LinkBtn> : null}
          />
          {notice ? (
            <div className="relative shrink-0 px-1">
              <NoticeBox notice={notice} />
              <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className="absolute right-4 top-3 cursor-pointer text-fg/45 hover:text-fg">
                <Icon name="close" className="size-4" />
              </button>
            </div>
          ) : null}
          <div className="thin-scroll flex min-h-0 flex-1 flex-col overflow-y-auto p-1">
            {view && current && view.obligation.id === current.id ? (
              <div className="space-y-5">
                <ActionsPanel view={view} operator={health?.operator ?? "operator"} busy={busy} run={run} />
                {health?.agent ? (
                  <div>
                    <Kicker>Or hand it back</Kicker>
                    <div className="mt-2.5">
                      <Btn tone="secondary" block disabled={agent.running} onClick={() => agent.start(current.id)} icon={<AgentMark size={20} />}>
                        {agent.running && agent.target === current.id ? "The agent is on it" : "Let the agent look again"}
                      </Btn>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </Tray>
      </div>
    </Workspace>
  );
}
