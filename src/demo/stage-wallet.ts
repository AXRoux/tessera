/**
 * Sandbox demos only: sets one wallet's available balance before the demo seeds its incidents, so the treasury story is
 * real. Sandbox wallets start with 10,000,000 EUR; the funding incident needs a EUR wallet that cannot cover a replacement,
 * so the excess is converted into USD (or a short wallet topped up from USD) with plain spot conversions.
 *
 * This is simulation, behind the Simulator interface like the transfer simulator: it is never on the funding path, it
 * writes nothing to the ledger, and against production there is no simulator to call it. Airwallex refuses a conversion
 * above about USD 5,000,000 (`amount_above_limit`), so a large excess moves in chunks.
 */
import type { AirwallexClient } from "../airwallex/client";
import { fromMinor, toMinor } from "../money";

/** Largest single staging conversion, in units of the currency moved: comfortably under Airwallex's USD 5M cap for EUR and GBP. */
const MAX_CHUNK_MAJOR = 2_000_000;

export async function stageWalletOnSandbox(client: AirwallexClient, currency: string, targetMajor: number, counter = "USD"): Promise<void> {
  if (currency === counter) throw new Error(`cannot stage ${currency} against itself`);
  const available = async (): Promise<number> => {
    const row = (await client.getBalances()).find((b) => b.currency === currency);
    return toMinor(row?.available_amount ?? 0, currency);
  };
  const target = toMinor(targetMajor, currency);
  for (let round = 0; round < 20; round++) {
    const gap = (await available()) - target;
    if (gap === 0) return;
    const chunk = Math.min(Math.abs(gap), toMinor(MAX_CHUNK_MAJOR, currency));
    const amount = fromMinor(chunk, currency);
    await client.sandboxSpotConversion(
      gap > 0
        ? { request_id: crypto.randomUUID(), sell_currency: currency, buy_currency: counter, sell_amount: amount }
        : { request_id: crypto.randomUUID(), sell_currency: counter, buy_currency: currency, buy_amount: amount },
    );
  }
  throw new Error(`the ${currency} wallet did not reach ${targetMajor} after 20 staging conversions`);
}
