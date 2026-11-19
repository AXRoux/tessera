/**
 * The bank's answer, played by Tessera where there is no bank: the Airwallex sandbox and the offline simulator.
 *
 * Neither moves a transfer by itself. A payout sits in PROCESSING until someone simulates what the bank does next
 * (Airwallex's builder guide: "Transfers ... otherwise remain in PROCESSING"), so a supplier payment made on the sandbox
 * would never be paid, never be certified, and look stuck forever.
 *
 * A transfer still in PROCESSING has never been touched: the demo incidents and the Simulate buttons all move theirs to
 * SENT first. So once a transfer has sat untouched for `afterMs`, the clock sends it and pays it, and syncs the ledger,
 * which hears about it exactly as it would hear about a real bank. Anything a person or the demo has moved is left
 * alone, so a failure can still be rehearsed by pressing a Simulate button before the clock gets there. Restart-safe:
 * the rule reads only the ledger. Never wired against production, where there is no simulator.
 *
 * One more rule plays the end of a delay (src/demo/morning.ts): a case whose brief says its transfer `lands` has its
 * delayed transfer paid once someone has made the call on it (the agent deferred it, or it was handed to a person) and
 * `landsAfterMs` has passed since. So holding can be seen to have been right, whenever the presenter gets to it. The
 * bank's part is chained as a STORY_STEP before the transfer moves, so the ledger says who played it.
 */
import { z } from "zod";
import type { PayoutGateway } from "../gateway/gateway";
import type { Attempt, Ledger } from "../ledger/ledger";
import type { Simulator } from "./api";

export const DEFAULT_BANK_CLOCK_MS = 15_000;
/** How long after the call to hold it a case's delayed transfer lands. */
export const DEFAULT_LANDS_AFTER_MS = 30_000;

const CaseBriefSchema = z.looseObject({ kind: z.string(), lands: z.boolean().optional() });

/** The calls that decide to hold a delayed transfer, or hand it over: after one of these, the delay may end. */
const HOLDING_CALLS = new Set(["AGENT_DEFERRED", "ESCALATED"]);

/** `TESSERA_BANK_CLOCK_MS`: milliseconds a transfer sits untouched before the clock pays it; 0 turns it off. */
export function parseBankClockMs(setting: string | undefined, fallback: number): number {
  const value = setting?.trim();
  if (!value) return fallback;
  const ms = Number(value);
  if (!Number.isSafeInteger(ms) || ms < 0) throw new Error(`TESSERA_BANK_CLOCK_MS must be a whole number of milliseconds >= 0 (got "${setting}")`);
  return ms;
}

export interface BankClockDeps {
  ledger: Ledger;
  gateway: PayoutGateway;
  simulator: Pick<Simulator, "advance">;
  afterMs: number;
  now?: () => number;
  /** Invoices whose bank is played by their story (src/demo/story.ts): the clock leaves them alone. */
  skip?: (obligationId: string) => boolean;
  /** A case's delayed transfer lands this long after the call to hold it. Default DEFAULT_LANDS_AFTER_MS. */
  landsAfterMs?: number;
}

export class BankClock {
  constructor(private readonly deps: BankClockDeps) {}

  /** Sends and pays every transfer that has sat untouched long enough. Returns the transfer ids it paid. */
  async tick(): Promise<string[]> {
    const { ledger, gateway, simulator, afterMs } = this.deps;
    const now = (this.deps.now ?? Date.now)();
    const live = ledger.syncableAttempts().filter((a) => a.state === "LIVE" && a.transferId !== null && !this.deps.skip?.(a.obligationId));
    const due = live.filter((a) => a.awxStatus === "PROCESSING" && now - Date.parse(a.createdAt) >= afterMs);
    const landing = live.filter((a) => a.awxStatus === "SENT" && this.lands(a, now));
    const paid: string[] = [];
    const failures: unknown[] = [];
    for (const attempt of [...due, ...landing]) {
      try {
        if (attempt.awxStatus === "SENT") {
          // The end of a case's delay: the bank's part goes on the record (once) before the transfer moves.
          if (!ledger.events(attempt.obligationId).some((e) => e.type === "STORY_STEP")) {
            ledger.append(attempt.obligationId, "STORY_STEP", { story: "morning", step: "lands", actor: "bank", by: "bank-clock" });
          }
        } else {
          // SENT before PAID, as a bank does (and as the sandbox requires). If a person moved it a moment ago, the
          // simulator refuses the SENT and the clock leaves it to them.
          await simulator.advance(attempt.transferId!, "SENT");
        }
        await simulator.advance(attempt.transferId!, "PAID");
        paid.push(attempt.transferId!);
      } catch (error) {
        failures.push(error);
      }
      // Whatever happened, the ledger hears it from Airwallex now rather than at the next sweep.
      await gateway.sync(attempt.obligationId).catch((error: unknown) => failures.push(error));
    }
    if (failures.length > 0 && paid.length === 0) throw failures[0];
    return paid;
  }

  /**
   * Whether a SENT transfer is the delayed one of a case that lands, and its delay is over: the first attempt, a brief
   * that says it lands, and a call to hold it (or hand it over) at least landsAfterMs ago.
   */
  private lands(attempt: Attempt, now: number): boolean {
    if (attempt.seq !== 1) return false;
    const events = this.deps.ledger.events(attempt.obligationId);
    const opened = events.findIndex((e) => e.type === "CASE_OPENED");
    if (opened < 0 || CaseBriefSchema.safeParse(events[opened]!.payload).data?.lands !== true) return false;
    const held = events.slice(opened + 1).find((e) => HOLDING_CALLS.has(e.type));
    return held !== undefined && now - Date.parse(held.ts) >= (this.deps.landsAfterMs ?? DEFAULT_LANDS_AFTER_MS);
  }
}
