"use client";

import Link from "next/link";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import type { CaseOutcome, CaseStep, Health, IncidentSummary } from "../../../src/server/wire";
import { money } from "@/lib/format";
import { useAgentRun } from "../agent/agent-run";
import { AgentMark } from "../kit/agent-mark";
import { Btn } from "../kit/metal";
import { Kicker, Tile, Toggle } from "../kit/widgets";
import { Icon } from "../landing/icons";
import { SupplierMark } from "../suppliers/supplier-mark";

type Lane = IncidentSummary & { case: NonNullable<IncidentSummary["case"]> };
type State = CaseOutcome["state"];

/** The nodes a lane's rail shows at most; earlier steps are counted, and the whole trail opens on a click. */
const MAX_NODES = 6;

const ACTOR: Record<CaseStep["actor"], string> = {
  agent: "Agent",
  test: "Guardrail test",
  you: "You",
  airwallex: "Airwallex",
  visa: "Visa",
  supplier: "Supplier",
  tessera: "Tessera",
};

/** What a step was, as a colour: red is stopped or failed, amber a person's part, blue the agent acting, green money landed. */
function pillTone(step: CaseStep): string {
  switch (step.kind) {
    case "refused":
    case "fail":
      return "bg-bad/12 text-bad ring-bad/35";
    case "handoff":
    case "draft":
    case "sign":
    case "release":
    case "send":
    case "resolve":
      return "bg-warn/12 text-warn ring-warn/35";
    case "paid":
    case "cleared":
    case "certify":
      return "bg-ok/14 text-ok ring-ok/40";
    case "act":
      return "bg-accent/14 text-accent ring-accent/35";
    default:
      return "bg-fg/[0.06] text-fg/80 ring-fg/12";
  }
}

/** Who made the move, as a mark small enough to sit inside a pill. */
function Who({ step, lane, size = 12 }: { step: Pick<CaseStep, "actor">; lane: Lane; size?: 11 | 12 }) {
  const box = size === 11 ? "size-[11px] shrink-0" : "size-3 shrink-0";
  switch (step.actor) {
    case "agent":
      return <AgentMark size={size} className="shrink-0 rounded-[3px]" />;
    case "test":
      return <Icon name="shield" className={box} />;
    case "you":
      return <Icon name="hand" className={box} />;
    case "airwallex":
      return <Icon name="wallet" className={box} />;
    case "visa":
      return <span className="shrink-0 font-sans text-[8.5px] font-black italic leading-none tracking-[-0.02em]">VISA</span>;
    case "supplier":
      return lane.supplier ? <SupplierMark supplier={lane.supplier} size={size + 2} /> : <Icon name="mail" className={box} />;
    case "tessera":
      return <Icon name="badge" className={box} />;
  }
}

/** One move as a node on the lane's rail: who made it, coloured by what it was. Hover for the sentence. */
function Node({ step, lane, fresh }: { step: CaseStep; lane: Lane; fresh: boolean }) {
  return (
    <li
      title={`${ACTOR[step.actor]}: ${step.text}`}
      className={`relative flex size-[22px] shrink-0 items-center justify-center rounded-full ring-1 ring-inset ${pillTone(step)} ${fresh ? "rise [animation-duration:0.45s]" : ""}`}
    >
      <Who step={step} lane={lane} />
      {step.count > 1 ? (
        <span className="readout absolute -right-1.5 -top-1.5 rounded-full bg-fg px-1 text-[8.5px] font-semibold leading-[13px] text-canvas">{step.count}</span>
      ) : null}
    </li>
  );
}

/** The text colour of a step's own tone, for the line under the rail. */
const LINE_TONE: Partial<Record<CaseStep["kind"], string>> = {
  refused: "text-bad", fail: "text-bad",
  handoff: "text-warn", draft: "text-warn", sign: "text-warn", release: "text-warn", send: "text-warn", resolve: "text-warn",
  paid: "text-ok", cleared: "text-ok", certify: "text-ok",
  act: "text-accent",
};

const OUTCOME: Record<State, { box: string; head: string; mark: ReactNode }> = {
  open: { box: "bg-bad/[0.07] ring-bad/30", head: "text-bad", mark: <span aria-hidden className="size-2 rounded-full bg-bad" /> },
  working: { box: "bg-accent/[0.09] ring-accent/30", head: "text-accent", mark: <span aria-hidden className="beat size-2 rounded-full bg-accent" /> },
  yours: { box: "bg-warn/[0.09] ring-warn/40", head: "text-warn", mark: <Icon name="hand" className="size-3.5" /> },
  solved: { box: "bg-ok/[0.11] ring-ok/45", head: "text-ok", mark: <Icon name="check" className="size-3.5" /> },
  certified: { box: "bg-ok/[0.18] ring-ok/60", head: "text-ok", mark: <Icon name="badge" className="size-3.5" /> },
};

function Outcome({ outcome, compact }: { outcome: CaseOutcome; compact: boolean }) {
  const look = OUTCOME[outcome.state];
  // Keyed on the state, so a lane that turns green rises into it rather than flipping silently.
  return (
    <div key={outcome.state} className={`rise flex min-w-0 flex-col justify-center rounded-[16px] px-3 py-2 ring-1 ring-inset [animation-duration:0.5s] ${look.box}`}>
      <p className={`flex min-w-0 items-start gap-1.5 text-[13px] font-semibold leading-tight ${look.head}`}>
        <span className="flex h-[1.15em] shrink-0 items-center">{look.mark}</span>
        <span className="line-clamp-2" title={outcome.headline}>
          {outcome.state === "certified" ? `${outcome.headline} · certified` : outcome.headline}
        </span>
      </p>
      {outcome.state === "yours" && outcome.yours ? (
        <p className={`mt-0.5 text-[11.5px] leading-snug text-fg/65 ${compact ? "line-clamp-1" : ""}`} title={outcome.yours}>
          {outcome.yours}
        </p>
      ) : outcome.detail ? (
        <p className={`mt-0.5 text-[11.5px] leading-snug text-fg/55 ${compact ? "line-clamp-1" : ""}`} title={outcome.detail}>
          {outcome.detail}
        </p>
      ) : null}
      {outcome.state === "solved" && outcome.yours ? (
        <p className={`mt-1 flex items-center gap-1 text-[11px] leading-snug text-warn ${compact ? "line-clamp-1" : ""}`} title={outcome.yours}>
          <Icon name="hand" className="size-3 shrink-0" />
          <span className="truncate">{outcome.yours}</span>
        </p>
      ) : null}
    </div>
  );
}

/** One supplier's case as a lane: the problem, the moves made on it so far, and where it landed. A click opens the whole trail. */
function CaseLane({ lane, open, working, onToggle }: { lane: Lane; open: boolean; working: boolean; onToggle: () => void }) {
  const c = lane.case;
  const solved = c.outcome.state === "solved" || c.outcome.state === "certified";
  const hidden = Math.max(0, c.steps.length - MAX_NODES);
  const shown = c.steps.slice(-MAX_NODES);
  const latest = c.steps.at(-1) ?? null;
  return (
    <li className={`rounded-[20px] transition-shadow ${working ? "ring-2 ring-accent/70" : open ? "ring-1 ring-fg/15" : ""}`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="grid w-full cursor-pointer grid-cols-[minmax(0,1.2fr)_minmax(0,1.15fr)_minmax(0,0.95fr)] items-stretch gap-2.5 rounded-[20px] p-1.5 text-left transition-colors hover:bg-fg/[0.03]"
      >
        {/* The problem, as the supplier sees it: red until it is answered, then quiet, struck through by the outcome. */}
        <div className={`flex min-w-0 flex-col justify-center rounded-[16px] px-3 py-2 ring-1 ring-inset ${solved ? "bg-fg/[0.03] ring-fg/10" : "bg-bad/[0.08] ring-bad/35"}`}>
          <div className="flex min-w-0 items-center gap-2">
            {lane.supplier ? <SupplierMark supplier={lane.supplier} size={22} /> : null}
            <span className="shrink-0 text-[12.5px] font-semibold">{lane.supplier?.name ?? lane.reference}</span>
            <span className="readout min-w-0 truncate text-[10.5px] text-fg/45" title={`${lane.reference} · ${money(lane.amountMinor, lane.currency)}`}>
              {money(lane.amountMinor, lane.currency)} · {lane.reference}
            </span>
          </div>
          <p className={`mt-1 line-clamp-2 text-[12.5px] font-medium leading-tight ${solved ? "text-fg/45 line-through decoration-fg/25" : "text-bad"}`} title={c.problem.detail}>
            {c.problem.headline}
          </p>
        </div>

        {/* The agent's moves and everyone else's, oldest first, as they land on the ledger: a rail, and the latest in words. */}
        <div className="flex min-w-0 flex-col justify-center gap-1.5 px-1">
          {c.steps.length === 0 && !working ? (
            <span className="flex items-center gap-2 text-[12px] text-fg/40">
              <Icon name="arrow" className="size-3.5" />
              Not worked yet
            </span>
          ) : (
            <>
              <ol className="flex min-w-0 items-center" aria-label={`${c.steps.length} steps`}>
                {hidden > 0 ? <li className="readout mr-1 shrink-0 text-[10.5px] text-fg/40">+{hidden}</li> : null}
                {shown.map((step, i) => (
                  <Fragment key={step.seq}>
                    {i > 0 ? <li aria-hidden className="h-px w-[6px] shrink-0 bg-fg/20" /> : null}
                    <Node step={step} lane={lane} fresh={i === shown.length - 1} />
                  </Fragment>
                ))}
                {working ? (
                  <>
                    {shown.length > 0 ? <li aria-hidden className="h-px w-[6px] shrink-0 bg-accent/60" /> : null}
                    <li className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-accent text-white">
                      <span aria-hidden className="beat size-1.5 rounded-full bg-white" />
                    </li>
                  </>
                ) : null}
              </ol>
              {working ? (
                <p className="truncate text-[11.5px] font-medium text-accent">Agent on it…</p>
              ) : latest ? (
                <p className="truncate text-[11.5px]" title={latest.text}>
                  <span className="text-fg/45">{ACTOR[latest.actor]} · </span>
                  <span className={`font-medium ${LINE_TONE[latest.kind] ?? "text-fg/80"}`}>
                    {latest.label}
                    {latest.count > 1 ? ` ×${latest.count}` : ""}
                  </span>
                </p>
              ) : null}
            </>
          )}
        </div>

        <Outcome outcome={c.outcome} compact={!open} />
      </button>

      {open ? <Trail lane={lane} /> : null}
    </li>
  );
}

/** The whole trail of one case: the problem in full, every move in a sentence, and what is left. */
function Trail({ lane }: { lane: Lane }) {
  const c = lane.case;
  return (
    <div className="rise mx-1.5 mb-1.5 grid gap-3 rounded-[16px] bg-fg/[0.035] p-3.5 [animation-duration:0.35s] md:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
      <div className="min-w-0 space-y-2">
        <Kicker className="text-bad!">The problem</Kicker>
        <p className="text-[13px] leading-relaxed text-fg/80">{c.problem.detail}</p>
        <Kicker className="pt-1 text-ok!">Where it landed</Kicker>
        <p className="text-[13px] leading-relaxed text-fg/80">
          {c.outcome.headline}
          {c.outcome.detail ? `. ${c.outcome.detail}` : "."}
        </p>
        {c.outcome.yours ? (
          <p className="flex items-start gap-1.5 text-[12.5px] leading-relaxed text-warn">
            <Icon name="hand" className="mt-0.5 size-3.5 shrink-0" />
            {c.outcome.yours}
          </p>
        ) : null}
        <Link href={`/incidents/${lane.id}`} className="inline-flex items-center gap-1 pt-1 text-[12.5px] font-medium text-accent hover:underline">
          Open {lane.reference} and its evidence
          <Icon name="arrow" className="size-3.5" />
        </Link>
      </div>
      <ol className="min-w-0 space-y-1.5">
        {c.steps.length === 0 ? <li className="text-[12.5px] text-fg/45">No move yet. Let the agent work it.</li> : null}
        {c.steps.map((step, i) => (
          <li key={step.seq} className="flex gap-2.5">
            <span className="flex w-5 shrink-0 flex-col items-center">
              <span className={`flex size-5 items-center justify-center rounded-full ring-1 ring-inset ${pillTone(step)}`}>
                <Who step={step} lane={lane} size={11} />
              </span>
              {i < c.steps.length - 1 ? <span aria-hidden className="mt-1 w-px flex-1 bg-fg/12" /> : null}
            </span>
            <p className="min-w-0 pb-1 text-[12.5px] leading-snug text-fg/75">
              <span className="font-semibold text-fg">{ACTOR[step.actor]}</span>
              <span className="text-fg/35"> · </span>
              {step.text}
              {step.count > 1 && step.kind !== "refused" ? <span className="readout text-[11px] text-fg/45"> ×{step.count}</span> : null}
            </p>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The counts the header shows, in the order a case travels: red, blue, amber, green. */
function tally(lanes: Lane[]) {
  const count = (states: State[]) => lanes.filter((l) => states.includes(l.case.outcome.state)).length;
  return { open: count(["open"]), working: count(["working"]), yours: count(["yours"]), solved: count(["solved", "certified"]), certified: count(["certified"]) };
}

/**
 * Step two, when there are cases: every supplier whose payment is stuck, one lane each, read left to right. The problem
 * starts red; each move lands as it is chained (the agent's tool calls and the policy's answers, a person's signature,
 * Airwallex, Visa); where it ends turns green. Everything but the problem's wording is read from the ledger.
 */
export function CasesPanel({
  items,
  health,
  onBoard,
  onMorning,
  loadingMorning,
}: {
  items: IncidentSummary[];
  health: Health | null;
  onBoard: () => void;
  onMorning: () => void;
  loadingMorning: boolean;
}) {
  const agent = useAgentRun();
  const [open, setOpen] = useState<string | null>(null);
  const lanes = useMemo(
    () => items.filter((i): i is Lane => Boolean(i.case)).sort((a, b) => a.case.openedSeq - b.case.openedSeq),
    [items],
  );
  const t = tally(lanes);
  const owed = lanes.reduce((sum, l) => sum + (l.currency === "USD" ? l.amountMinor : 0), 0);
  // The lane the agent is on right now: the invoice its latest tool call names.
  const lastCall = agent.running ? agent.state.steps.findLast((s) => s.kind === "tool" && s.incident !== null) : undefined;
  const workingOn = lastCall?.kind === "tool" ? lastCall.incident : null;
  const canSeed = Boolean(health && (health.offline || health.sandbox));
  const where = health?.offline ? "the offline simulator" : "the Airwallex sandbox";

  return (
    <Tile invert as="section" className="flex h-full min-h-0 flex-col rounded-[30px]! p-5 xl:p-6">
      <header className="flex shrink-0 items-start justify-between gap-4">
        <div className="min-w-0">
          <Kicker>
            02 · This morning
            {lanes.length > 0 ? (
              <span className="normal-case tracking-normal">
                {" "}
                · {money(owed, "USD")} owed to {lanes.length} suppliers{t.certified > 0 ? ` · ${t.certified} certified` : ""}
              </span>
            ) : null}
          </Kicker>
          {lanes.length > 0 ? (
            <p className="mt-2 text-[clamp(24px,2.1vw,34px)] font-semibold leading-none tracking-[-0.04em]">
              <span className="text-bad">{lanes.length} stuck</span>
              <span className="mx-2 text-fg/25">→</span>
              <span className="text-ok">{t.solved} solved</span>
            </p>
          ) : (
            <p className="mt-2 text-[clamp(22px,1.9vw,30px)] font-semibold leading-none tracking-[-0.04em]">Nothing stuck yet</p>
          )}
        </div>
        <Toggle
          label="View"
          value="cases"
          onChange={(v) => v === "board" && onBoard()}
          options={[
            { id: "cases", label: "Cases" },
            { id: "board", label: "Board" },
          ]}
        />
      </header>

      {lanes.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <span className="flex size-14 items-center justify-center rounded-[18px] bg-bad/12 text-bad ring-1 ring-inset ring-bad/30">
            <Icon name="bolt" className="size-6" />
          </span>
          <div className="max-w-[520px] space-y-2">
            <p className="text-[18px] font-semibold tracking-[-0.02em]">Six supplier payments went out on the last run. This morning, each one is stuck.</p>
            <p className="text-[13px] leading-relaxed text-fg/60">
              Bounced at the bank, still in transit, returned as a duplicate, unseen by the supplier, and one email from an impostor. Each was approved and paid
              {canSeed ? ` on ${where}` : ""}; the agent works them under policy, and you sign what it cannot.
            </p>
          </div>
          {canSeed ? (
            <Btn busy={loadingMorning} onClick={onMorning} icon={<Icon name="bolt" className="size-4" />}>
              {loadingMorning ? `Setting them up on ${health?.offline ? "the simulator" : "Airwallex"}…` : "Load this morning"}
            </Btn>
          ) : (
            <p className="text-[12.5px] text-fg/45">Cases appear here when a supplier payment runs into trouble.</p>
          )}
        </div>
      ) : (
        <>
          {/* Where the morning stands at a glance: one segment per case, coloured by where it is now. */}
          <div className="mt-3.5 shrink-0">
            <div className="flex h-1.5 gap-1 overflow-hidden rounded-full" role="img" aria-label={`${t.open} unsolved, ${t.working} in progress, ${t.yours} yours, ${t.solved} solved`}>
              {(
                [
                  [t.solved, "bg-ok"],
                  [t.yours, "bg-warn"],
                  [t.working, "bg-accent"],
                  [t.open, "bg-bad"],
                ] as const
              ).map(([n, fill]) => (n > 0 ? <span key={fill} className={`h-full rounded-full transition-[flex-grow] duration-700 ${fill}`} style={{ flexGrow: n }} /> : null))}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-fg/55">
              {(
                [
                  [t.open, "unsolved", "bg-bad"],
                  [t.working, "in progress", "bg-accent"],
                  [t.yours, "waiting on you", "bg-warn"],
                  [t.solved, "solved", "bg-ok"],
                ] as const
              ).map(([n, word, dot]) => (
                <span key={word} className="flex items-center gap-1.5">
                  <span aria-hidden className={`size-2 rounded-full ${dot}`} />
                  <span className="readout font-medium text-fg/80">{n}</span> {word}
                </span>
              ))}
            </div>
          </div>

          <div className="mt-3 grid shrink-0 grid-cols-[minmax(0,1.2fr)_minmax(0,1.15fr)_minmax(0,0.95fr)] gap-2.5 px-1.5 pb-1.5">
            <Kicker className="pl-3 text-bad!">The problem</Kicker>
            <Kicker className="pl-1">The agent, step by step</Kicker>
            <Kicker className="pl-3 text-ok!">Where it landed</Kicker>
          </div>
          <ul className="thin-scroll -mx-1.5 min-h-0 flex-1 space-y-1 overflow-y-auto px-1.5 pb-1">
            {lanes.map((lane) => (
              <CaseLane
                key={lane.id}
                lane={lane}
                open={open === lane.id}
                working={workingOn === lane.reference}
                onToggle={() => setOpen((current) => (current === lane.id ? null : lane.id))}
              />
            ))}
          </ul>
        </>
      )}
    </Tile>
  );
}
