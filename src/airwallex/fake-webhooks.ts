/**
 * Offline parity for webhooks: when the simulated Airwallex moves a transfer, it delivers a signed event to Tessera's
 * webhook route, shaped like the real ones captured from the sandbox (fixtures/webhooks/*.json): `data` is the whole
 * transfer, `created_at` uses `+0000`, the signature is HMAC-SHA256 of `x-timestamp` + body. The delivery goes through
 * the same route function the public listener serves, in process, with no port opened.
 */
import { randomUUID } from "node:crypto";
import type { Transfer } from "./types";
import { signWebhook } from "./webhook";

/** Airwallex's timestamp style: whole seconds and `+0000`. */
export function airwallexTime(date: Date): string {
  return `${date.toISOString().slice(0, 19)}+0000`;
}

/** The raw body of a `payout.transfer.<status>` event for `transfer`, as Airwallex sends it (API version 2026-08-21). */
export function transferEventBody(transfer: Transfer, options: { accountId: string; now?: Date; id?: string }): string {
  return JSON.stringify({
    id: options.id ?? randomUUID(),
    name: `payout.transfer.${transfer.status.toLowerCase()}`,
    account_id: options.accountId,
    data: transfer,
    created_at: airwallexTime(options.now ?? new Date()),
    version: "2026-08-21",
  });
}

/** A signed delivery of `rawBody` to `url`, with the headers Airwallex sends. */
export function signedDelivery(url: string, secret: string, rawBody: string, timestamp = String(Date.now())): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-timestamp": timestamp, "x-signature": signWebhook(secret, timestamp, rawBody) },
    body: rawBody,
  });
}

export const OFFLINE_ACCOUNT_ID = "acct_offline_simulated";
const OFFLINE_URL = "http://simulated-airwallex.invalid/api/webhooks/airwallex";

/** Delivers the simulated Airwallex's events to whatever route is bound (the current demo instance's). */
export class OfflineWebhooks {
  private route: ((request: Request) => Promise<Response>) | null = null;
  private quiet = 0;

  constructor(private readonly secret: string) {}

  bind(route: (request: Request) => Promise<Response>): void {
    this.route = route;
  }

  /** Runs `fn` without deliveries: seeding the demo writes history, not news. */
  async withoutEvents<T>(fn: () => Promise<T>): Promise<T> {
    this.quiet++;
    try {
      return await fn();
    } finally {
      this.quiet--;
    }
  }

  /** Delivers one event for the transfer's current state and waits for Tessera's answer. */
  async emit(transfer: Transfer): Promise<void> {
    if (!this.route || this.quiet > 0) return;
    const body = transferEventBody(structuredClone(transfer), { accountId: OFFLINE_ACCOUNT_ID });
    const response = await this.route(signedDelivery(OFFLINE_URL, this.secret, body));
    if (response.status !== 200) console.error(`simulated webhook for transfer ${transfer.id} answered ${response.status}`);
  }
}
