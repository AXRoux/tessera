/**
 * Event-driven agent runs: a reaction that changed an incident's decision into something an agent can act on wakes
 * an agent for that one incident, within seconds, instead of waiting for someone to press "let the agent work".
 *
 * Off unless TESSERA_AGENT_ON_EVENT=1, and never on in a public demo. A woken run is an ordinary run: the same
 * toolbox, scoped to the incident, the same authority, refusals and approvals as one started from the console, under
 * the agent's usual name. The ledger names what woke it (`AGENT_WAKE` lists the reactions and Airwallex event ids)
 * and how it ended (`AGENT_WAKE_FINISHED`).
 *
 * What keeps it from looping or being driven into the ground:
 *  - debounce: the first request opens a short window and later ones join it, so a burst (FAILED, then CANCELLED a
 *    second later) is one run, and a stream of events cannot postpone it forever;
 *  - single flight per incident: a request while that incident's run is going is held and becomes at most one
 *    follow-up run after it;
 *  - one agent at a time in the process: the gate is shared with the console's runs; a wake waits for it, bounded;
 *  - caps per incident and overall in a rolling window, counted from the ledger, so a restart does not reset them;
 *  - only bank-side changes wake anything (src/server/reactions.ts), and an agent's own actions are not bank-side.
 */
import { COMMANDER_SYSTEM, runAgent } from "../agent/loop";
import { createToolbox } from "../agent/toolbox";
import type { Closer } from "../closer/closer";
import type { Commander } from "../commander/commander";
import type { StructuredModel } from "../commander/evidence";
import { AgentWakeFinishedSchema, AgentWakeSchema } from "../ledger/events";
import type { PayoutGateway } from "../gateway/gateway";
import type { Ledger } from "../ledger/ledger";
import type { AgentDeps } from "./api";
import { type AgentGate, runLimits, scopedTask } from "./agent-runs";
import type { WakeCause } from "./reactions";

export interface WakeLimits {
  /** How long a first request waits for others to join it. */
  debounceMs: number;
  /** Started wakes allowed per incident in `windowMs`. */
  perIncident: number;
  /** Started wakes allowed across all incidents in `windowMs`. */
  global: number;
  windowMs: number;
  /** How long a wake waits for another agent run to finish before it is recorded as skipped. */
  maxGateWaitMs: number;
}

export const DEFAULT_WAKE_LIMITS: WakeLimits = { debounceMs: 2_000, perIncident: 3, global: 12, windowMs: 3600_000, maxGateWaitMs: 5 * 60_000 };

/** The longest closing report an `AGENT_WAKE_FINISHED` keeps. */
const WAKE_REPORT_MAX_CHARS = 600;

export interface WakeDeps {
  ledger: Ledger;
  gateway: PayoutGateway;
  commander: Commander;
  closer: Closer;
  model: StructuredModel | null;
  agent: AgentDeps;
  gate: AgentGate;
  limits?: Partial<WakeLimits>;
  now?: () => Date;
}

interface Slot {
  causes: WakeCause[];
  timer: ReturnType<typeof setTimeout> | null;
}

export class WakeScheduler {
  private readonly slots = new Map<string, Slot>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly abort = new AbortController();
  private readonly limits: WakeLimits;

  constructor(private readonly deps: WakeDeps) {
    this.limits = { ...DEFAULT_WAKE_LIMITS, ...deps.limits };
  }

  /** Asks for a run on one incident. Returns at once; the run (or its refusal) is written to the ledger. */
  request(obligationId: string, cause: WakeCause): void {
    if (this.abort.signal.aborted) return;
    const slot = this.slots.get(obligationId);
    if (slot) {
      // Joins the open window, or waits for the running wake and becomes its one follow-up.
      slot.causes.push(cause);
      return;
    }
    this.slots.set(obligationId, { causes: [cause], timer: this.arm(obligationId) });
  }

  /** Resolves when nothing is waiting or running. For tests and an orderly shutdown. */
  async idle(): Promise<void> {
    for (;;) {
      if (this.inFlight.size > 0) {
        await Promise.all(this.inFlight);
        continue;
      }
      const armed = [...this.slots.values()].some((s) => s.timer !== null);
      if (!armed) return;
      await Bun.sleep(Math.max(10, this.limits.debounceMs / 4));
    }
  }

  /** Cancels waiting wakes and stops running ones at their next step (a demo reset, a shutdown). */
  stop(): void {
    this.abort.abort();
    for (const slot of this.slots.values()) clearTimeout(slot.timer ?? undefined);
    this.slots.clear();
  }

  private arm(obligationId: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      const work = this.fire(obligationId).catch((error) => console.error("agent wake failed", error instanceof Error ? error.message : error));
      this.inFlight.add(work);
      void work.finally(() => this.inFlight.delete(work));
    }, this.limits.debounceMs);
  }

  private async fire(obligationId: string): Promise<void> {
    const slot = this.slots.get(obligationId);
    if (!slot) return;
    slot.timer = null;
    const causes = slot.causes.splice(0);
    try {
      await this.wake(obligationId, causes);
    } finally {
      if (slot.causes.length > 0 && !this.abort.signal.aborted) slot.timer = this.arm(obligationId);
      else this.slots.delete(obligationId);
    }
  }

  private record(obligationId: string, causes: WakeCause[], outcome: "started" | "capped" | "skipped", detail: string | null) {
    return this.deps.ledger.append(obligationId, "AGENT_WAKE", AgentWakeSchema.parse({
      outcome,
      reactionSeqs: causes.map((c) => c.reactionSeq),
      eventIds: causes.flatMap((c) => (c.eventId ? [c.eventId] : [])),
      eventNames: [...new Set(causes.flatMap((c) => (c.eventName ? [c.eventName] : [])))],
      actor: this.deps.agent.actor,
      detail,
    }));
  }

  /** Started wakes in the window, from the ledger: per incident and overall. */
  private started(obligationId: string): { incident: number; all: number } {
    const since = new Date((this.deps.now?.() ?? new Date()).getTime() - this.limits.windowMs).toISOString();
    let incident = 0;
    let all = 0;
    for (const event of this.deps.ledger.recentEvents(["AGENT_WAKE"], since)) {
      if (AgentWakeSchema.safeParse(event.payload).data?.outcome !== "started") continue;
      all++;
      if (event.obligationId === obligationId) incident++;
    }
    return { incident, all };
  }

  private async wake(obligationId: string, causes: WakeCause[]): Promise<void> {
    const { ledger, gate, agent } = this.deps;
    const obligation = ledger.getObligation(obligationId);
    if (!obligation) return;
    if (obligation.status === "CLOSED" || obligation.status === "ESCALATED") {
      this.record(obligationId, causes, "skipped", `the incident is ${obligation.status.toLowerCase()} by the time the agent would start`);
      return;
    }
    const used = this.started(obligationId);
    if (used.incident >= this.limits.perIncident) {
      this.record(obligationId, causes, "capped", `${used.incident} event-driven runs on this incident in the last ${Math.round(this.limits.windowMs / 60_000)} min (limit ${this.limits.perIncident})`);
      return;
    }
    if (used.all >= this.limits.global) {
      this.record(obligationId, causes, "capped", `${used.all} event-driven runs in the last ${Math.round(this.limits.windowMs / 60_000)} min (limit ${this.limits.global})`);
      return;
    }

    const deadline = Date.now() + this.limits.maxGateWaitMs;
    while (!gate.tryAcquire()) {
      const left = deadline - Date.now();
      if (this.abort.signal.aborted) return;
      if (left <= 0 || !(await gate.whenFree(left))) {
        this.record(obligationId, causes, "skipped", "another agent run held the ledger for too long; the sweep and the console still cover this incident");
        return;
      }
    }

    let wakeSeq: number | null = null;
    try {
      wakeSeq = this.record(obligationId, causes, "started", null).seq;
      const scope = new Set([obligationId]);
      const toolbox = createToolbox({
        ledger, gateway: this.deps.gateway, commander: this.deps.commander, closer: this.deps.closer, model: this.deps.model,
        actor: agent.actor, acceptClientText: false, scope,
      });
      const names = [...new Set(causes.flatMap((c) => (c.eventName ? [c.eventName] : [])))];
      const why = names.length > 0 ? `Airwallex reported ${names.join(" and ")} for it` : "the background sweep saw its transfer change";
      const run = await runAgent({
        model: agent.model, toolbox, system: COMMANDER_SYSTEM,
        task: `${scopedTask(obligation)} You were woken because ${why}; the transfer has been re-read and the assessment changed.`,
        ...runLimits(ledger, scope, { adversary: false, ...(agent.maxSteps !== undefined ? { fixedSteps: agent.maxSteps } : {}) }),
        signal: this.abort.signal,
      });
      ledger.append(obligationId, "AGENT_WAKE_FINISHED", AgentWakeFinishedSchema.parse({
        wakeSeq, actor: agent.actor, steps: run.steps, calls: run.calls.length,
        refused: run.calls.filter((c) => !c.outcome.ok && c.outcome.kind === "refused").length, stoppedBecause: run.stoppedBecause,
        tools: run.calls.map((c) => `${c.tool}:${c.outcome.ok ? "ok" : c.outcome.kind}`),
        report: run.finalText.trim().slice(0, WAKE_REPORT_MAX_CHARS) || null,
      }));
    } catch (error) {
      console.error("event-driven agent run failed", error instanceof Error ? error.message : error);
      if (wakeSeq !== null) {
        ledger.append(obligationId, "AGENT_WAKE_FINISHED", { wakeSeq, actor: agent.actor, steps: 0, calls: 0, refused: 0, stoppedBecause: "error" });
      }
    } finally {
      gate.release();
    }
  }
}
