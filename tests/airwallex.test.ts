import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { FakePayoutApi } from "../src/airwallex/fake";
import { AwxHttpError } from "../src/airwallex/types";
import { verifyWebhook } from "../src/airwallex/webhook";
import { WebhookRejected } from "../src/errors";
import { fakeHttp, jsonResponse } from "./helpers/fake-fetch";

const SECRET = "whsec_test_secret";
const NOW = Date.parse("2026-10-30T12:00:00Z");

function signed(body: unknown, timestamp = String(NOW)) {
  const rawBody = JSON.stringify(body);
  const signature = createHmac("sha256", SECRET).update(timestamp + rawBody).digest("hex");
  return { secret: SECRET, timestamp, signature, rawBody, now: NOW };
}

const paidEvent = {
  id: "evt_1", name: "payout.transfer.paid", account_id: "acct_1", created_at: "2026-10-30T11:59:58Z",
  data: { object: { id: "tr_123", status: "PAID" } },
};

describe("webhook verification", () => {
  it("accepts a correctly signed, fresh delivery and names the transfer", () => {
    expect(verifyWebhook(signed(paidEvent))).toEqual({
      id: "evt_1", name: "payout.transfer.paid", createdAt: "2026-10-30T11:59:58Z", transferId: "tr_123",
    });
  });

  it("rejects a body that does not match its signature", () => {
    const input = signed(paidEvent);
    const tampered = { ...input, rawBody: input.rawBody.replace("tr_123", "tr_999") };

    expect(() => verifyWebhook(tampered)).toThrow(WebhookRejected);
    expect(() => verifyWebhook({ ...input, signature: "zz" })).toThrow(WebhookRejected);
    expect(() => verifyWebhook({ ...input, signature: null })).toThrow(WebhookRejected);
  });

  it("rejects a correctly signed delivery replayed more than five minutes later", () => {
    const old = signed(paidEvent, String(NOW - 6 * 60_000));

    const error = (() => {
      try {
        verifyWebhook(old);
      } catch (e) {
        return e;
      }
    })();

    expect(error).toBeInstanceOf(WebhookRejected);
    expect((error as WebhookRejected).reason).toBe("stale");
  });

  it("does not name a transfer for events that are not about transfers", () => {
    expect(verifyWebhook(signed({ ...paidEvent, name: "account.updated" })).transferId).toBeNull();
  });
});

describe("Airwallex client", () => {
  it("follows page_after to the end when listing transfers", async () => {
    const fake = new FakePayoutApi({ pageSize: 2 });
    for (let i = 0; i < 5; i++) {
      await fake.createTransfer({
        request_id: `req-${i}`, beneficiary_id: "ben-A", source_currency: "USD", transfer_currency: "USD",
        transfer_amount: 10, transfer_method: "LOCAL", reason: "r", reference: `INV-${i}`,
      });
    }
    const http = fakeHttp(fake);

    const transfers = await http.client.listTransfers(new Date(0).toISOString());

    expect(transfers.map((t) => t.reference)).toEqual(["INV-0", "INV-1", "INV-2", "INV-3", "INV-4"]);
  });

  it("waits as long as a 429's Retry-After asks before retrying a read", async () => {
    const fake = new FakePayoutApi();
    const http = fakeHttp(fake);
    http.queued.push(jsonResponse({ code: "too_many_requests", message: "slow down" }, 429, { "retry-after": "7" }));

    await expect(http.client.listTransfers(new Date(0).toISOString())).resolves.toEqual([]);

    expect(http.waits).toEqual([7_000]);
  });

  it("does not retry a rate-limited create, and reports how long Airwallex asked to wait", async () => {
    const http = fakeHttp(new FakePayoutApi());
    http.queued.push(jsonResponse({ code: "too_many_requests", message: "slow down" }, 429, { "retry-after": "2" }));

    const error = await http.client
      .createTransfer({
        request_id: "req-1", beneficiary_id: "ben-A", source_currency: "USD", transfer_currency: "USD",
        transfer_amount: 10, transfer_method: "LOCAL", reason: "r", reference: "INV-1",
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AwxHttpError);
    expect(error).toMatchObject({ status: 429, retryAfterMs: 2_000 });
    expect(http.calls.filter((c) => c.startsWith("POST /api/v1/transfers/create"))).toHaveLength(1);
  });

  it("logs in once when concurrent requests all need a token", async () => {
    const http = fakeHttp(new FakePayoutApi());

    await Promise.all([1, 2, 3].map(() => http.client.listTransfers(new Date(0).toISOString())));

    expect(http.calls.filter((c) => c.includes("/authentication/login"))).toHaveLength(1);
  });
});

describe("fake Airwallex simulator", () => {
  it("maps a sandbox failure_type to its captured failure code", async () => {
    const fake = new FakePayoutApi();
    const transfer = await fake.createTransfer({
      request_id: "req-1", beneficiary_id: "ben-A", source_currency: "USD", transfer_currency: "USD",
      transfer_amount: 10, transfer_method: "LOCAL", reason: "r", reference: "INV-1",
    });

    fake.advance(transfer.id, "FAILED", "BENEFICIARY_BANK_RETURNED");

    expect((await fake.getTransfer(transfer.id)).failure?.code).toBe("90802");
  });
});
