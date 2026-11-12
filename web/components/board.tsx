"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Acknowledged, api, ApiProblem } from "@/lib/client-api";
import { actorLabel, agentVerdict } from "@/lib/agent-verdict";
import { ago, duration, money } from "@/lib/format";
import { ATTEMPT, describeFailure, SQUARE, STATUS } from "@/lib/status";
import { ACTION_WORDS } from "@/lib/describe-event";
import { IncidentListSchema, MetricsSchema, SeedResultSchema, type Health, type IncidentSummary, type Metrics } from "../../src/server/wire";
import { AgentTimeline, agentName, useAgentRun } from "./agent/agent-run";
import { AgentRail } from "./agent-rail";
import { Logo } from "./logo";
import { resetTour, Tour } from "./tour";
import { Button, Tag } from "./ui";

const POLL_MS = 4000;

/** Earlier attempts must have ended (they were replaced), so only the latest one can still be moving. */
function AttemptSquares({ item }: { item: IncidentSummary }) {
  const earlier = Math.max(0, item.attemptCount - 1);
  return (
    <span className="inline-flex items-center gap-1.5" aria-label={`${item.attemptCount} attempt${item.attemptCount === 1 ? "" : "s"}`}>
      {Array.from({ length: earlier }, (_, i) => (
        <span key={i} className="size-2.5 rounded-full bg-white/70" />
      ))}
      {item.latest ? <span className={`size-2.5 rounded-full ${SQUARE[item.latest.state]}`} /> : <span className="size-2.5 rounded-full border border-white/25" />}
    </span>
  );
}

/** The agent's latest verdict on the incident, in words. A refusal is as loud here as in the transcript. */
function VerdictLine({ item }: { item: IncidentSummary }) {
  const action = item.lastAgentAction;
  if (!action) return null;
  const verdict = agentVerdict(action);
  return (
    <p className="mt-1.5 text-[12px] leading-snug text-muted">
      <span className={verdict.refused ? "rounded bg-danger/15 px-1.5 py-0.5 font-medium text-danger [box-decoration-break:clone]" : "font-medium text-soft"}>{verdict.label}</span>{" "}
      <span suppressHydrationWarning>&middot; {actorLabel(action.actor)} &middot; {ago(action.at)}</span>
    </p>
  );
}

/** Tessera's latest reaction to a bank-side change: which Airwallex event made it look, and what changed. */
function ReactionLine({ item }: { item: IncidentSummary }) {
  const reaction = item.lastReaction;
  if (!reaction || reaction.source === "setup") return null;
  const cause = reaction.source === "webhook" ? `Webhook ${reaction.eventName ?? "from Airwallex"}` : "Seen by the sweep";
  const change = reaction.before !== reaction.after
    ? `${ACTION_WORDS[reaction.before] ?? reaction.before} → ${ACTION_WORDS[reaction.after] ?? reaction.after}`
    : `still ${ACTION_WORDS[reaction.after] ?? reaction.after}`;
  const woke = reaction.woke === "started" ? " · agent woken" : reaction.woke ? ` · agent ${reaction.woke}` : "";
  return (
    <p className="mt-1 text-[11.5px] leading-snug text-muted">
      <span className="font-mono">{cause}</span>
      <span suppressHydrationWarning> &middot; {change}{woke} &middot; {ago(reaction.at)}</span>
    </p>
  );
}

function FailureCell({ item }: { item: IncidentSummary }) {
  if (!item.latest) return <span className="text-muted">None</span>;
  if (!item.latest.failureCode) return <span className="text-muted">{ATTEMPT[item.latest.state].label}</span>;
  const failure = describeFailure(item.latest.failureCode);
  return (
    <span className="block leading-snug">
      <span className="block text-[13px]">{failure.name}</span>
      <span className="block text-[11px] text-muted">{failure.playbook}</span>
    </span>
  );
}

function heldBack(metrics: Metrics): string {
  const lines = Object.entries(metrics.refusedAmountMinor).filter(([, minor]) => minor > 0);
  if (lines.length === 0) return money(0, "USD");
  return lines.map(([currency, minor]) => money(minor, currency)).join(" + ");
}

/** One line of numbers instead of a strip that eats a third of the fold. */
function Kpis({ metrics, awaiting }: { metrics: Metrics | null; awaiting: number }) {
  const read = (f: (m: Metrics) => string | number): string | number => (metrics ? f(metrics) : "—");
  const cells: readonly (readonly [string, string | number])[] = [
    ["Tracked", read((m) => m.incidents)],
    ["Refused by code", read((m) => m.paymentsRefused)],
    ["Money held back", read(heldBack)],
    ["Replaced", read((m) => m.autoReplaced)],
    ["Certified", read((m) => m.certified)],
    ["Median certify", read((m) => (m.medianResolutionMs === null ? "—" : duration(m.medianResolutionMs)))],
    ["Awaiting you", awaiting],
  ];
  return (
    <dl className="flex flex-wrap items-center gap-x-7 gap-y-2 text-[13px]">
      {cells.map(([label, value]) => (
        <div key={label} className="flex items-baseline gap-2">
          <dd className="tnum text-[15px] font-medium">{value}</dd>
          <dt className="text-muted">{label}</dt>
        </div>
      ))}
    </dl>
  );
}

export function Board({ initial, initialMetrics, health }: { initial: IncidentSummary[]; initialMetrics: Metrics | null; health: Health | null }) {
  const router = useRouter();
  const [items, setItems] = useState(initial);
  const [metrics, setMetrics] = useState(initialMetrics);
  const [creating, setCreating] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seeded, setSeeded] = useState<string | null>(null);
  const [showTable, setShowTable] = useState(false);

  const refresh = useCallback(async () => {
    const [list, numbers] = await Promise.allSettled([api("obligations", IncidentListSchema), api("metrics", MetricsSchema)]);
    if (list.status === "fulfilled") setItems(list.value.items);
    if (numbers.status === "fulfilled") setMetrics(numbers.value);
  }, []);

  const agent = useAgentRun(() => void refresh());

  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  async function create() {
    setCreating(true);
    setError(null);
    try {
      const created = await api("obligations", Acknowledged, { method: "POST", body: { amount: 25 } });
      const id = typeof created.id === "string" ? created.id : null;
      if (id) router.push(`/incidents/${id}`);
      else await refresh();
    } catch (e) {
      setError(e instanceof ApiProblem ? e.problem.message : "The test invoice could not be created.");
    } finally {
      setCreating(false);
    }
  }

  async function seed() {
    setSeeding(true);
    setError(null);
    setSeeded(null);
    try {
      const result = await api("demo/seed", SeedResultSchema, { method: "POST" });
      setSeeded(`Opened ${result.seeded.length} incidents: ${result.seeded.map((s) => s.reference).join(", ")}.`);
      await refresh();
    } catch (e) {
      setError(e instanceof ApiProblem ? e.problem.message : "The demo incidents could not be created.");
    } finally {
      setSeeding(false);
    }
  }

  async function reset() {
    setResetting(true);
    setError(null);
    try {
      await api("demo/reset", Acknowledged, { method: "POST" });
      agent.clear();
      resetTour();
      setSeeded(null);
      setConfirmingReset(false);
      await refresh();
    } catch (e) {
      setError(e instanceof ApiProblem ? e.problem.message : "The demo could not be reset.");
    } finally {
      setResetting(false);
    }
  }

  const idFor = (reference: string) => items.find((i) => i.reference === reference)?.id;
  const awaiting = items.filter((i) => i.attention !== null).length;
  const canSeed = Boolean(health && (health.offline || health.sandbox));
  const name = agentName(health?.agent);
  const running = agent.running;

  return (
    <div className="mx-auto max-w-[1200px] px-6 sm:px-10">
      {health?.offline ? (
        <p className="flex items-start gap-3 text-[13px] leading-snug text-muted">
          <span aria-hidden className="mt-[6px] size-1.5 shrink-0 rounded-full bg-sky" />
          {health.agent?.kind === "model"
            ? `Offline demo: simulated Airwallex, agent runs by ${health.agent.name}. No money and no bank are involved.`
            : "Offline demo: simulated Airwallex, scripted agent. The agent is a deterministic script, not a model."}
        </p>
      ) : null}

      <Tour items={items} metrics={metrics} health={health} onSeed={seed} onRun={(mode) => agent.start(null, mode)} seeding={seeding} running={running} />

      <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,7fr)_minmax(0,4fr)]">
        <div className="min-w-0">
          {agent.state.status === "idle" ? (
            <section className="card flex flex-col items-center gap-4 px-6 py-16 text-center">
              <Logo size={40} />
              <p className="heading text-[26px]">{canSeed ? "The board is quiet" : "Nothing has happened yet"}</p>
              <p className="max-w-md text-[14px] font-light leading-relaxed text-soft">
                {canSeed
                  ? `${name.charAt(0).toUpperCase() + name.slice(1)} works the board through ten typed tools. Start it, and every call and refusal lands here in order.`
                  : "Send a test invoice to open your first incident. Tessera records the instruction before any money moves."}
              </p>
              <div className="mt-2 flex flex-wrap justify-center gap-3">
                {canSeed && items.length > 0 ? (
                  <Button onClick={() => agent.start(null)}>{`Let ${name} work them all`}</Button>
                ) : canSeed ? (
                  <Button onClick={seed} busy={seeding}>
                    Load the incidents
                  </Button>
                ) : null}
                <Button variant="secondary" onClick={create} busy={creating}>
                  Send a test invoice
                </Button>
              </div>
            </section>
          ) : (
            <section className="card overflow-hidden">
              <header className="flex flex-wrap items-center justify-between gap-4 border-b border-rule px-5 py-4">
                <div>
                  <div className="flex items-center gap-3">
                    <span className="text-[15px] font-medium">{agent.state.mode === "adversary" ? "Adversary run" : "Agent run"}</span>
                    <Tag tone={agent.state.mode === "adversary" ? "ink" : "blue-outline"} pulse={running}>
                      {running ? "Working" : "Finished"}
                    </Tag>
                  </div>
                  <p className="mt-1 text-[13px] text-muted">
                    {agent.state.mode === "adversary"
                      ? "Told to pay twice and talk its way past the rules. Every refusal is the point."
                      : "What the agent tried, and what the code answered."}
                  </p>
                </div>
                <button type="button" onClick={agent.clear} className="cursor-pointer text-[13px] text-muted underline underline-offset-4 hover:text-white">
                  Clear
                </button>
              </header>
              <AgentTimeline state={agent.state} idFor={idFor} />
            </section>
          )}
        </div>

        <AgentRail health={health} metrics={metrics} items={items} awaiting={awaiting} onSeed={seed} canSeed={canSeed} seeding={seeding} />
      </div>


      <div className="mt-8 flex flex-wrap items-center justify-between gap-4">
        <Kpis metrics={metrics} awaiting={awaiting} />
        <div className="flex flex-wrap items-center gap-2.5">
          <Button variant="quiet" onClick={() => setShowTable((open) => !open)}>
            {showTable ? "Hide the table" : `All incidents (${items.length})`}
          </Button>
          {canSeed ? (
            <Button variant="secondary" onClick={seed} busy={seeding}>
              Seed incidents
            </Button>
          ) : null}
          {health?.canReset ? (
            confirmingReset ? (
              <>
                <Button onClick={reset} busy={resetting}>
                  Confirm reset
                </Button>
                <Button variant="quiet" onClick={() => setConfirmingReset(false)} disabled={resetting}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button variant="quiet" onClick={() => setConfirmingReset(true)}>
                Reset demo
              </Button>
            )
          ) : null}
        </div>
      </div>

      {error ? (
        <p role="alert" className="mt-6 rounded-2xl border border-danger/50 bg-danger/10 px-5 py-4 text-sm">
          {error}
        </p>
      ) : null}
      {seeded ? (
        <p role="status" className="mt-6 rounded-2xl border border-blue/50 bg-wash px-5 py-4 text-sm">
          {seeded}
        </p>
      ) : null}

      {showTable ? (
        <div className="card mt-6 overflow-x-auto">
          <table className="w-full min-w-[820px] border-collapse text-left">
            <thead>
              <tr className="border-b border-rule">
                {["Invoice", "Amount", "Status", "Attempts", "Latest failure", "Updated"].map((h) => (
                  <th key={h} scope="col" className="label h-12 px-6 text-left font-normal first:pl-8">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-8 py-10 text-center text-[14px] text-muted">
                    No incidents yet.
                  </td>
                </tr>
              ) : (
                items.map((item) => {
                  const status = STATUS[item.status];
                  return (
                    <tr key={item.id} className="group relative border-b border-rule last:border-b-0 hover:bg-white/[0.035]">
                      <td className="relative px-6 py-4 pl-8">
                        <Link href={`/incidents/${item.id}`} className="font-mono text-[13px] after:absolute after:inset-0">
                          {item.reference}
                        </Link>
                      </td>
                      <td className="tnum px-6 text-[15px] font-medium">{money(item.amountMinor, item.currency)}</td>
                      <td className="px-6 py-3">
                        <Tag tone={status.tone} pulse={status.pulse}>
                          {status.label}
                        </Tag>
                        <VerdictLine item={item} />
                        <ReactionLine item={item} />
                      </td>
                      <td className="px-6">
                        <AttemptSquares item={item} />
                      </td>
                      <td className="px-6 py-3">
                        <FailureCell item={item} />
                      </td>
                      <td suppressHydrationWarning className="px-6 text-[13px] text-muted">
                        {ago(item.updatedAt)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
