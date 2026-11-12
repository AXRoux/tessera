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
import { RunReport } from "./agent/run-report";
import { Logo } from "./logo";
import { NeedsYou } from "./needs-you";
import { resetTour, Tour } from "./tour";
import { Container } from "./landing/section";
import { Button, Frame, Label, PanelHeader, Stat, StatStrip, Tag } from "./ui";
import { WalletStrip } from "./wallet-strip";

const POLL_MS = 4000;

/** Earlier attempts must have ended (they were replaced), so only the latest one can still be moving. */
function AttemptSquares({ item }: { item: IncidentSummary }) {
  const earlier = Math.max(0, item.attemptCount - 1);
  return (
    <span className="inline-flex items-center gap-1.5" aria-label={`${item.attemptCount} attempt${item.attemptCount === 1 ? "" : "s"}`}>
      {Array.from({ length: earlier }, (_, i) => (
        <span key={i} className="size-3 rounded-full bg-ink" />
      ))}
      {item.latest ? <span className={`size-3 rounded-full ${SQUARE[item.latest.state]}`} /> : <span className="size-3 rounded-full border border-white/25" />}
    </span>
  );
}

/** The agent's latest verdict on the incident, in words. A refusal is as loud here as in the agent timeline. */
function VerdictLine({ item }: { item: IncidentSummary }) {
  const action = item.lastAgentAction;
  if (!action) return null;
  const verdict = agentVerdict(action);
  return (
    <p className="mt-2 max-w-[320px] text-[12px] leading-[1.9] text-muted">
      <span className={verdict.refused ? "rounded bg-danger/15 px-1.5 py-0.5 font-medium text-danger [box-decoration-break:clone]" : "font-medium text-ink"}>{verdict.label}</span>
      <span suppressHydrationWarning>
        {" "}
        &middot; {actorLabel(action.actor)} &middot; {ago(action.at)}
      </span>
    </p>
  );
}

/** Tessera's latest reaction to a bank-side change: which Airwallex event (or the sweep) made it look, and what changed. */
function ReactionLine({ item }: { item: IncidentSummary }) {
  const reaction = item.lastReaction;
  if (!reaction || reaction.source === "setup") return null;
  const cause = reaction.source === "webhook" ? `Webhook ${reaction.eventName ?? "from Airwallex"}` : "Seen by the sweep";
  const change = reaction.before !== reaction.after
    ? `${ACTION_WORDS[reaction.before] ?? reaction.before} → ${ACTION_WORDS[reaction.after] ?? reaction.after}`
    : `still ${ACTION_WORDS[reaction.after] ?? reaction.after}`;
  const agent = reaction.woke === "started" ? " · agent woken" : reaction.woke ? ` · agent ${reaction.woke}` : "";
  return (
    <p className="mt-1 max-w-[320px] text-[12px] leading-[1.9] text-muted">
      <span className="font-mono">{cause}</span>
      <span suppressHydrationWarning>
        {" "}
        &middot; {change}
        {agent} &middot; {ago(reaction.at)}
      </span>
    </p>
  );
}

function FailureCell({ item }: { item: IncidentSummary }) {
  if (!item.latest) return <span className="text-muted">None</span>;
  if (!item.latest.failureCode) return <span className="text-muted">{ATTEMPT[item.latest.state].label}</span>;
  const failure = describeFailure(item.latest.failureCode);
  return (
    <span className="block leading-snug">
      <span className="block font-medium">{failure.name}</span>
      <span className="block text-xs text-muted">
        {failure.playbook} &middot; <span className="font-mono">{item.latest.failureCode}</span>
      </span>
    </span>
  );
}

/** Refused money, per currency. Several currencies are listed side by side; nothing refused reads as zero. */
function heldBack(metrics: Metrics): string {
  const lines = Object.entries(metrics.refusedAmountMinor).filter(([, minor]) => minor > 0);
  if (lines.length === 0) return money(0, "USD");
  return lines.map(([currency, minor]) => money(minor, currency)).join(" + ");
}

/** The numbers a judge asks for first, all derived from ledger events by the API. Dashes while they cannot be read. */
function MetricsStrip({ metrics, awaiting }: { metrics: Metrics | null; awaiting: number }) {
  const value = <T,>(read: (m: Metrics) => T) => (metrics ? read(metrics) : "\u2014");
  return (
    <StatStrip columns={6}>
      <Stat value={value((m) => m.incidents)} label="Invoices tracked" />
      <Stat value={value((m) => m.paymentsRefused)} label="Payments refused by code" />
      <Stat value={value(heldBack)} label="Money held back" />
      <Stat value={value((m) => m.autoReplaced)} label="Replaced automatically" />
      <Stat value={value((m) => (m.medianResolutionMs === null ? "\u2014" : duration(m.medianResolutionMs)))} label="Median time to certify" />
      <Stat value={awaiting} label="Awaiting a person" />
    </StatStrip>
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

  const refresh = useCallback(async () => {
    // Each read stands alone: a failed one keeps the last good value and the next poll retries.
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
      setSeeded(`Opened ${result.seeded.length} demo incident${result.seeded.length === 1 ? "" : "s"}: ${result.seeded.map((s) => s.reference).join(", ")}.`);
      await refresh();
    } catch (e) {
      setError(e instanceof ApiProblem ? e.problem.message : "The demo incidents could not be created.");
    } finally {
      setSeeding(false);
    }
  }

  /** Offline demo only. Clears the shared in-memory state, then starts the walkthrough over. */
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

  const runCommander = () => agent.start(null);
  const runAdversary = () => agent.start(null, "adversary");
  const idFor = (reference: string) => items.find((i) => i.reference === reference)?.id;

  // The same derivation as the "Needs you" queue: an incident is waiting for a person when the server gives it an attention reason.
  const awaiting = items.filter((i) => i.attention !== null).length;
  const canSeed = Boolean(health && (health.offline || health.sandbox));
  const name = agentName(health?.agent);
  const Name = agentName(health?.agent, true);
  const agentReady = Boolean(health?.agent) && items.length > 0;
  const runningMode = agent.running ? agent.state.mode : null;

  return (
    <>
      <Container>
        {health?.offline ? (
          <p className="flex items-start gap-3 text-[14px] font-light leading-snug text-muted">
            <span aria-hidden className="mt-[7px] size-1.5 shrink-0 rounded-full bg-sky" />
            {health.agent?.kind === "model"
              ? `Offline demo: simulated Airwallex, agent runs by ${health.agent.name}. No money and no bank are involved.`
              : "Offline demo: simulated Airwallex, scripted agent. The agent here is a deterministic script, not a model."}
          </p>
        ) : null}

        <Tour
          items={items}
          metrics={metrics}
          health={health}
          onSeed={seed}
          onRun={(mode) => (mode === "adversary" ? runAdversary() : runCommander())}
          seeding={seeding}
          running={agent.running}
        />

        {agent.state.status !== "idle" ? (
          <div className="mt-8">
            <Frame tone="blue">
              <PanelHeader
                title={agent.state.mode === "adversary" ? "Adversary agent" : "Commander agent"}
                right={
                  <span className="flex items-center gap-5">
                    {agent.target ? (
                      <Link href={`/incidents/${agent.target}`} className="text-[13px] text-soft underline decoration-white/30 underline-offset-4 hover:text-white">
                        One incident
                      </Link>
                    ) : null}
                    {agent.running ? (
                      <button type="button" onClick={agent.stop} className="cursor-pointer text-[13px] text-soft underline decoration-white/30 underline-offset-4 hover:text-white">
                        Stop
                      </button>
                    ) : null}
                    <Label className={agent.state.mode === "adversary" ? "text-ink" : "text-sky"}>{agent.state.actor ?? Name}</Label>
                  </span>
                }
              />
              <p aria-live="polite" className="sr-only">
                {agent.state.status === "running" ? `${Name} is working.` : agent.state.status === "error" ? "The agent run stopped before it finished." : ""}
              </p>
              <RunReport state={agent.state} idFor={idFor} />
              <AgentTimeline state={agent.state} idFor={idFor} />
            </Frame>
          </div>
        ) : null}

        <NeedsYou items={items} />
      </Container>

      <div className="mt-12">
        <MetricsStrip metrics={metrics} awaiting={awaiting} />
      </div>
      <WalletStrip />

      <section aria-labelledby="incidents" className="mx-auto max-w-[1200px] px-6 pt-14 sm:px-10">
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-6">
          <div>
            <h3 id="incidents" className="heading text-[clamp(26px,3vw,32px)]">
              All incidents
            </h3>
            {health ? (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Tag tone={health.agent ? "blue-outline" : "muted"}>
                  {health.agent?.kind === "model" ? `${health.agent.name} connected` : health.agent?.kind === "scripted" ? "Scripted agent, not a model" : "No agent connected"}
                </Tag>
                <Tag tone={health.sandbox ? "blue-outline" : "muted"}>
                  {health.offline ? "Simulated Airwallex" : health.sandbox ? "Simulator on" : "Simulator off"}
                </Tag>
              </div>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <Button onClick={create} busy={creating}>
                Send a test invoice
              </Button>
              {canSeed ? (
                <Button variant="secondary" onClick={seed} busy={seeding}>
                  Seed demo incidents
                </Button>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              <Button variant="secondary" disabled={!agentReady || agent.running} busy={runningMode === "commander"} onClick={runCommander}>
                {runningMode === "commander" ? `${Name} is working` : `Let ${name} work them all`}
              </Button>
              {health?.sandbox ? (
                <Button variant="secondary" disabled={!agentReady || agent.running} busy={runningMode === "adversary"} onClick={runAdversary}>
                  {runningMode === "adversary" ? `${Name} is attacking` : "Try to break it"}
                </Button>
              ) : null}
            </div>
            {health?.canReset ? (
              confirmingReset ? (
                <span className="flex flex-wrap items-center gap-3">
                  <span className="text-[13px] text-muted">Clears every incident for everyone using this demo.</span>
                  <Button onClick={reset} busy={resetting}>
                    Confirm reset
                  </Button>
                  <Button variant="secondary" onClick={() => setConfirmingReset(false)} disabled={resetting}>
                    Cancel
                  </Button>
                </span>
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

        {items.length === 0 ? (
          <div className="card mt-8 grid place-items-center gap-5 px-6 py-20 text-center">
            <Logo size={44} />
            <p className="heading text-[28px]">No incidents yet</p>
            <p className="max-w-md text-[15px] font-light leading-relaxed text-soft">
              {canSeed
                ? "Load the seven demo incidents to see every branch of the playbook at once, or send a single test invoice. Tessera records the payment instruction before any money moves."
                : "Send a test invoice to open your first incident. Tessera records the payment instruction before any money moves."}
            </p>
            <div className="flex flex-wrap justify-center gap-3">
              {canSeed ? (
                <Button variant="secondary" onClick={seed} busy={seeding}>
                  Seed demo incidents
                </Button>
              ) : null}
              <Button onClick={create} busy={creating}>
                Send a test invoice
              </Button>
            </div>
          </div>
        ) : (
          <div className="card mt-8 overflow-x-auto">
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
                {items.map((item) => {
                  const status = STATUS[item.status];
                  return (
                    <tr key={item.id} className="group relative border-b border-rule transition-colors last:border-b-0 hover:bg-white/[0.035]">
                      <td className="relative h-[76px] px-6 pl-8">
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
                      <td className="px-6 py-3 text-sm">
                        <FailureCell item={item} />
                      </td>
                      <td suppressHydrationWarning className="px-6 text-sm text-muted">
                        {ago(item.updatedAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
