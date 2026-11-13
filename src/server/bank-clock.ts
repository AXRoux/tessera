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
 */
import type { PayoutGateway } from "../gateway/gateway";
import type { Ledger } from "../ledger/ledger";
import type { Simulator } from "./api";

export const DEFAULT_BANK_CLOCK_MS = 15_000;

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
}

export class BankClock {
  constructor(private readonly deps: BankClockDeps) {}

  /** Sends and pays every transfer that has sat untouched long enough. Returns the transfer ids it paid. */
  async tick(): Promise<string[]> {
    const { ledger, gateway, simulator, afterMs } = this.deps;
    const now = (this.deps.now ?? Date.now)();
    const due = ledger
      .syncableAttempts()
      .filter((a) => a.state === "LIVE" && a.awxStatus === "PROCESSING" && a.transferId !== null && now - Date.parse(a.createdAt) >= afterMs);
    const paid: string[] = [];
    const failures: unknown[] = [];
    for (const attempt of due) {
      try {
        // SENT before PAID, as a bank does (and as the sandbox requires). If a person moved it a moment ago, the
        // simulator refuses the SENT and the clock leaves it to them.
        await simulator.advance(attempt.transferId!, "SENT");
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
}
