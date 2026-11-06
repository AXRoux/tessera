/**
 * Reactions: what Tessera does when Airwallex moves a transfer it holds.
 *
 * The single source of "a transfer changed" is the ledger's own `TRANSFER_STATUS` events, written by the gateway's
 * sync (`PayoutGateway.sync` / `syncTransfer`) after it re-read the transfer. Whatever applied the change (a webhook's
 * re-read, the background sweep, a console view that synced first), the reaction is the same: for each incident with
 * bank-side changes no reaction covers yet, compute the Commander's decision with those changes taken back and with
 * them applied, record both as `INCIDENT_REACTION`, and ask for an agent only if the decision changed into something
 * an agent can act on. A verified webhook that names the transfer is credited as the trigger; otherwise the sweep is.
 *
 * Reactions never move money and never trust an event body: the decision is computed from the ledger after the
 * re-read, so a webhook that claims PAID while Airwallex says otherwise changes nothing.
 */
import { z } from "zod";
import type { Commander } from "../commander/commander";
import { effectiveEvidence } from "../commander/evidence";
import {
  IncidentReactionSchema,
  REACTABLE_VIA,
  reactedStatusSeqs,
  replayAttempts,
  TransferStatusPayloadSchema,
  type DecisionBrief,
  type IncidentReaction,
  type ReactionChange,
} from "../ledger/events";
import { statusFor, type Attempt, type Ledger, type LedgerEvent, type Obligation } from "../ledger/ledger";

const AttemptRefSchema = z.looseObject({ attemptId: z.string() });

/** Changes older than this are history, not news: a restart reacts to recent ones it missed, never to last month's. */
export const REACTION_WINDOW_MS = 30 * 60_000;

/** Decisions an agent has nothing to do for: waiting is the Commander's job, and NONE means nothing is open. */
const QUIET: Readonly<Record<string, true>> = { NONE: true, WAIT: true };

/** Events the gateway writes as part of applying a transfer change; taken back together to see the decision before it. */
const CHANGE_TYPES: Readonly<Record<string, true>> = { TRANSFER_STATUS: true, FAILURE_RECORDED: true, LATE_FAILURE: true, UNKNOWN_STATUS: true };

export interface WakeCause {
  reactionSeq: number;
  eventId: string | null;
  eventName: string | null;
}

export interface ReactorDeps {
  ledger: Ledger;
  commander: Pick<Commander, "decideOn" | "readWallets">;
  /** Called after a reaction that asks for an agent; null when event-driven agents are off. */
  wake: ((obligationId: string, cause: WakeCause) => void) | null;
  now?: () => Date;
  windowMs?: number;
}

/**
 * A webhook trigger names the transfer it was about, so its credit goes to that transfer's incident only. `setup` is
 * the demo seeding its incidents: their history is recorded as reacted to, and never wakes an agent.
 */
export type ReactTrigger =
  | { source: "sweep" }
  | { source: "setup" }
  | { source: "webhook"; eventId: string; eventName: string; eventCreatedAt: string; transferId: string | null };

const brief = (d: { recommended: string; severity: string; allowed: readonly string[] }): DecisionBrief => ({
  recommended: d.recommended, severity: d.severity, allowed: [...d.allowed].sort(),
});

const sameDecision = (a: DecisionBrief, b: DecisionBrief): boolean =>
  a.recommended === b.recommended && a.severity === b.severity && a.allowed.join(",") === b.allowed.join(",");

export class Reactor {
  /** Incidents whose reaction is being computed, so two triggers arriving together do not both react. */
  private readonly busy = new Set<string>();

  constructor(private readonly deps: ReactorDeps) {}

  /**
   * Reacts to every pending bank-side change (the sweep), or only to the incident a webhook's transfer belongs to.
   * Returns the reactions written.
   */
  async react(trigger: ReactTrigger): Promise<IncidentReaction[]> {
    const { ledger } = this.deps;
    const now = this.deps.now?.() ?? new Date();
    const since = new Date(now.getTime() - (this.deps.windowMs ?? REACTION_WINDOW_MS)).toISOString();
    const only = trigger.source === "webhook" ? (trigger.transferId ? ledger.attemptByTransferId(trigger.transferId)?.obligationId ?? null : null) : null;
    if (trigger.source === "webhook" && only === null) return [];

    const pending = this.pending(since, only);
    if (pending.size === 0) return [];
    // One balance read for every decision in this pass: before and after differ by the bank event and nothing else.
    const wallets = await this.deps.commander.readWallets();
    const written: IncidentReaction[] = [];
    for (const [obligationId, changes] of pending) {
      if (this.busy.has(obligationId)) continue;
      this.busy.add(obligationId);
      try {
        const reaction = this.reactTo(obligationId, changes, trigger, since, wallets);
        if (reaction) written.push(reaction);
      } finally {
        this.busy.delete(obligationId);
      }
    }
    return written;
  }

  /** Bank-side `TRANSFER_STATUS` changes in the window that no reaction covers yet, by incident. */
  private pending(since: string, only: string | null): Map<string, Array<{ event: LedgerEvent; change: ReactionChange }>> {
    const { ledger } = this.deps;
    const reacted = reactedStatusSeqs(ledger.recentEvents(["INCIDENT_REACTION"], since));
    const byIncident = new Map<string, Array<{ event: LedgerEvent; change: ReactionChange }>>();
    for (const event of ledger.recentEvents(["TRANSFER_STATUS"], since)) {
      if (event.obligationId === null || reacted.has(event.seq) || (only !== null && event.obligationId !== only)) continue;
      const p = TransferStatusPayloadSchema.safeParse(event.payload);
      // A transfer Tessera just created (from null) is its own doing, not news from the bank.
      if (!p.success || p.data.from === null || !Object.hasOwn(REACTABLE_VIA, p.data.via)) continue;
      const list = byIncident.get(event.obligationId) ?? [];
      list.push({
        event,
        change: { statusSeq: event.seq, attemptId: p.data.attemptId, transferId: p.data.transferId, from: p.data.from, to: p.data.to, failureCode: p.data.failureCode },
      });
      byIncident.set(event.obligationId, list);
    }
    return byIncident;
  }

  private reactTo(
    obligationId: string,
    pending: Array<{ event: LedgerEvent; change: ReactionChange }>,
    trigger: ReactTrigger,
    since: string,
    wallets: Record<string, number> | null,
  ): IncidentReaction | null {
    const { ledger, commander } = this.deps;
    const obligation = ledger.requireObligation(obligationId);
    const attempts = ledger.attemptsFor(obligationId);
    const events = ledger.events(obligationId);
    const evidence = effectiveEvidence(events, obligation.amountMinor)?.evidence ?? null;
    const changes = pending.map((p) => p.change);

    const after = brief(commander.decideOn({ obligation, attempts, events }, evidence, wallets));
    const before = brief(commander.decideOn(takeBack({ obligation, attempts, events }, changes), evidence, wallets));
    const decisionChanged = !sameDecision(before, after);
    const actionable = decisionChanged && !Object.hasOwn(QUIET, after.recommended) && obligation.status !== "CLOSED" && obligation.status !== "ESCALATED";
    const credited = trigger.source === "webhook" && changes.some((c) => c.transferId === trigger.transferId);
    const setup = trigger.source === "setup";
    const reaction: IncidentReaction = IncidentReactionSchema.parse({
      changes,
      trigger: credited
        ? { source: "webhook", eventId: trigger.eventId, eventName: trigger.eventName, eventCreatedAt: trigger.eventCreatedAt }
        : { source: setup ? "setup" : "sweep", eventId: null, eventName: null, eventCreatedAt: null },
      before,
      after,
      decisionChanged,
      wake: this.deps.wake === null ? "off" : !actionable ? "not_needed" : setup ? "suppressed" : "requested",
    });

    // Written only if nothing covered these changes meanwhile: the check and the append are one transaction.
    const event = ledger.tx(() => {
      const covered = reactedStatusSeqs(ledger.recentEvents(["INCIDENT_REACTION"], since));
      if (changes.some((c) => covered.has(c.statusSeq))) return null;
      return ledger.append(obligationId, "INCIDENT_REACTION", reaction);
    });
    if (!event) return null;
    if (reaction.wake === "requested") {
      this.deps.wake?.(obligationId, { reactionSeq: event.seq, eventId: reaction.trigger.eventId, eventName: reaction.trigger.eventName });
    }
    return reaction;
  }
}

/**
 * The incident as it stood before `changes`: each changed attempt as its own events said just before the first change
 * (state, status, failure code), the events that applied the changes removed, and the obligation's derived status
 * recomputed (a status the changes themselves made sticky, such as an escalation for a late failure, is taken back too).
 */
export function takeBack(
  snapshot: { obligation: Obligation; attempts: Attempt[]; events: LedgerEvent[] },
  changes: ReactionChange[],
): { obligation: Obligation; attempts: Attempt[]; events: LedgerEvent[] } {
  const first = Math.min(...changes.map((c) => c.statusSeq));
  const changed = new Set(changes.map((c) => c.attemptId));
  const prior = replayAttempts(snapshot.events.filter((e) => e.seq < first));
  const attempts = snapshot.attempts.map((a) => {
    const r = changed.has(a.id) ? prior.get(a.id) : undefined;
    return r ? { ...a, state: r.state, awxStatus: r.awxStatus, failureCode: r.failureCode } : a;
  });
  const appliedByChange = (e: LedgerEvent): boolean => {
    if (e.seq < first) return false;
    if (e.type === "ESCALATED" || e.type === "CERTIFICATE_REVOKED") return true;
    if (!Object.hasOwn(CHANGE_TYPES, e.type)) return false;
    const attemptId = AttemptRefSchema.safeParse(e.payload).data?.attemptId;
    return typeof attemptId === "string" && changed.has(attemptId);
  };
  const events = snapshot.events.filter((e) => !appliedByChange(e));
  const escalatedByChange = snapshot.events.some((e) => e.seq >= first && e.type === "ESCALATED");
  const { obligation } = snapshot;
  const sticky = obligation.status === "CLOSED" || (obligation.status === "ESCALATED" && !escalatedByChange);
  return {
    obligation: sticky ? obligation : { ...obligation, status: statusFor(attempts.at(-1) ?? null), escalationReason: escalatedByChange ? null : obligation.escalationReason },
    attempts,
    events,
  };
}
