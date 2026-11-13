import { describe, expect, it } from "bun:test";
import type { FakePayoutApi } from "../src/airwallex/fake";
import { createApi } from "../src/server/api";
import { buildRuntime } from "../src/server/runtime";

const TOKEN = "token-for-wallet-staging";

describe("opening other wallets on a one-currency sandbox business", () => {
  it("buys EUR and GBP only where they are short, and refuses where there is no simulator", async () => {
    const runtime = buildRuntime({ TESSERA_OFFLINE: "1" });
    const fake = runtime.api as unknown as FakePayoutApi;
    fake.balances.set("EUR", 0);
    fake.balances.set("GBP", 9_000);
    const deps = {
      ledger: runtime.ledger, gateway: runtime.gateway, commander: runtime.commander, closer: runtime.closer, model: null,
      token: TOKEN, operator: "ops", beneficiaryId: "b", paidHoldMs: 0,
    };
    const post = (handle: ReturnType<typeof createApi>, body: unknown) =>
      handle(new Request("http://t/api/wallets/stage", { method: "POST", headers: { "x-tessera-token": TOKEN, "content-type": "application/json" }, body: JSON.stringify(body) }));

    const staged = await post(createApi({ ...deps, simulator: runtime.simulator }), { amount: 5_000 });
    expect(await staged.json()).toEqual({ ok: true, staged: ["EUR", "GBP"] });
    expect(fake.balances.get("EUR")).toBe(5_000);
    expect(fake.balances.get("GBP")).toBe(9_000); // already above the amount: left alone

    expect((await post(createApi({ ...deps, simulator: null }), {})).status).toBe(403);
  });
});
