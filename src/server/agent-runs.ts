/**
 * What every agent run in the API process shares, whoever starts it: the operator from the console, or a bank event
 * (src/server/wake.ts). One gate, so two agents never work one ledger at once, and one budget rule.
 */
import type { Ledger } from "../ledger/ledger";

/** One agent run at a time per process. Claimed synchronously, so two callers arriving together cannot both pass. */
export class AgentGate {
  private held = false;
  private readonly waiters = new Set<() => void>();

  get busy(): boolean {
    return this.held;
  }

  tryAcquire(): boolean {
    if (this.held) return false;
    this.held = true;
    return true;
  }

  release(): void {
    this.held = false;
    const waiting = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiting) wake();
  }

  /** Resolves the next time the gate is released (at once if it is free), or after `timeoutMs`. True if it was released. */
  whenFree(timeoutMs: number): Promise<boolean> {
    if (!this.held) return Promise.resolve(true);
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const done = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      this.waiters.delete(done);
      resolve(false);
    }, timeoutMs);
    this.waiters.add(done);
    return promise;
  }
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Room for every open incident in scope: about three model turns and six tool calls each. */
export function runLimits(
  ledger: Ledger,
  scope: ReadonlySet<string> | null,
  options: { adversary: boolean; fixedSteps?: number },
): { maxSteps: number; maxCalls: number } {
  const open = ledger.listObligations().filter((o) => o.status !== "CLOSED" && (!scope || scope.has(o.id))).length;
  return {
    maxSteps: options.adversary ? 24 : (options.fixedSteps ?? clamp(4 + 3 * open, 16, 48)),
    maxCalls: clamp(10 + 6 * open, 40, 300),
  };
}

/**
 * The brief for a run scoped to one incident, the same words for a console run and an event-driven one. It names the
 * incidentId the tools take as well as the reference people use: given only the reference, Claude passed it as the
 * incidentId, was told the incident was outside its scope, and stopped without acting (observed live 2026-11-03).
 */
export function scopedTask(incident: { id: string; reference: string }): string {
  return `Work incident ${incident.reference} (incidentId ${incident.id}) only. Do not touch any other incident. Report in one or two sentences.`;
}

/** The brief for a run over a chosen set of incidents (the board's "work these"), naming each id as the tools take it. */
export function scopedTasks(incidents: { id: string; reference: string }[]): string {
  const list = incidents.map((i) => `${i.reference} (incidentId ${i.id})`).join("; ");
  return `Work these incidents only: ${list}. Do not touch any other incident. Report one sentence per incident.`;
}
