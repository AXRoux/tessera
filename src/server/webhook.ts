/**
 * `POST /api/webhooks/airwallex`, as served by the webhook-only listener (src/server/webhook-listener.ts).
 *
 * Airwallex webhooks are hints (https://www.airwallex.com/docs/developer-tools/webhooks/webhooks-overview.md): delivered
 * at least once, retried with exponential back-off for about three days until a 200, in no guaranteed order. So:
 *
 *  1. verified by signature and age before anything is parsed or trusted;
 *  2. deduplicated by event id (Airwallex reuses one event id across retries, and across subscriptions: observed
 *     2026-11-03, one `payout.transfer.sent` id delivered once per subscription);
 *  3. the transfer is re-read from Airwallex and adopted like any sync. The body's status is never applied, so an old
 *     event arriving late, or one claiming PAID while Airwallex says otherwise, cannot move the ledger, and the gateway
 *     drops a re-read older than what it already holds;
 *  4. recorded (dedupe row + `WEBHOOK_RECEIVED`) only after the re-read succeeded: if it fails the answer is 503 and
 *     Airwallex redelivers instead of the dedupe swallowing the event. A transfer that mismatches the ledger is
 *     escalated by the sync itself, so it is handled, not retried;
 *  5. then the incident is reassessed (src/server/reactions.ts), which may wake an agent for it.
 *
 * The body is bounded before it is read: the content-length is checked first, and the listener caps the rest.
 */
import { verifyWebhook } from "../airwallex/webhook";
import { LedgerMismatchError, WebhookRejected } from "../errors";
import type { PayoutGateway } from "../gateway/gateway";
import type { Ledger } from "../ledger/ledger";
import type { Reactor } from "./reactions";
import { WEBHOOK_MAX_BODY_BYTES } from "./webhook-listener";

export interface WebhookHandlerDeps {
  ledger: Ledger;
  gateway: Pick<PayoutGateway, "syncTransfer">;
  secret: string;
  reactor: Pick<Reactor, "react"> | null;
  now?: () => number;
}

const json = (body: unknown, status = 200): Response => Response.json(body, { status, headers: { "cache-control": "no-store" } });

export function createWebhookHandler(deps: WebhookHandlerDeps): (request: Request) => Promise<Response> {
  const { ledger, gateway } = deps;
  return async (request) => {
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > WEBHOOK_MAX_BODY_BYTES) return json({ error: "PayloadTooLarge", message: "request body too large" }, 413);
    const rawBody = await request.text();
    if (rawBody.length > WEBHOOK_MAX_BODY_BYTES) return json({ error: "PayloadTooLarge", message: "request body too large" }, 413);

    let event;
    try {
      event = verifyWebhook({
        secret: deps.secret, timestamp: request.headers.get("x-timestamp"), signature: request.headers.get("x-signature"), rawBody,
        ...(deps.now ? { now: deps.now() } : {}),
      });
    } catch (error) {
      if (!(error instanceof WebhookRejected)) throw error;
      return json({ error: error.name, message: error.message }, error.reason === "malformed" ? 400 : 401);
    }
    if (ledger.webhookEventSeen(event.id)) return json({ ok: true, duplicate: true });

    let outcome = "not_a_transfer";
    let obligationId: string | null = null;
    if (event.transferId) {
      // A later-created event already taken for this transfer makes this one old news. It is still re-read (harmless,
      // and the transfer may have moved since), but it is recorded as out of order.
      const latest = ledger.latestWebhookFor(event.transferId);
      const outOfOrder = latest !== null && latest.createdAt > event.createdAt;
      const before = ledger.attemptByTransferId(event.transferId);
      try {
        const after = await gateway.syncTransfer(event.transferId);
        obligationId = after?.obligationId ?? null;
        const moved = after !== null && (after.awxStatus !== before?.awxStatus || after.state !== before?.state || after.failureCode !== before?.failureCode);
        outcome = after === null ? "unknown_transfer" : outOfOrder ? "out_of_order" : moved ? "applied" : "no_change";
      } catch (error) {
        if (!(error instanceof LedgerMismatchError)) {
          console.error("webhook sync failed; leaving the event retryable", error instanceof Error ? error.message : error);
          return json({ error: "SyncFailed", message: "the transfer could not be re-read; redeliver this event" }, 503);
        }
        obligationId = before?.obligationId ?? null;
        outcome = "mismatch_escalated";
      }
    }
    if (!ledger.recordWebhookEvent(event, { obligationId, claimedStatus: event.claimedStatus, outcome })) {
      return json({ ok: true, duplicate: true });
    }

    if (deps.reactor && event.transferId && obligationId) {
      try {
        await deps.reactor.react({ source: "webhook", eventId: event.id, eventName: event.name, eventCreatedAt: event.createdAt, transferId: event.transferId });
      } catch (error) {
        // The delivery is handled and recorded; the sweep reacts to anything a failed reaction missed.
        console.error("reaction failed; the sweep will retry it", error instanceof Error ? error.message : error);
      }
    }
    return json({ ok: true, duplicate: false, outcome });
  };
}
