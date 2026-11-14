import { describe, expect, it } from "bun:test";
import { createApi } from "../src/server/api";
import { buildRuntime } from "../src/server/runtime";
import { CardsSchema } from "../src/server/wire";
import { keyFromJwk } from "../src/cards/tap";

const TOKEN = "operator-token-for-card-tests";

function offlineApi(env: Record<string, string> = {}) {
  const runtime = buildRuntime({ TESSERA_OFFLINE: "1", ...env });
  const handle = createApi({
    ledger: runtime.ledger, gateway: runtime.gateway, commander: runtime.commander, closer: runtime.closer, cards: runtime.cards,
    model: null, simulator: runtime.simulator, token: TOKEN, operator: "ops@tessera.demo", beneficiaryId: "offline-us-supplier",
    paidHoldMs: runtime.paidHoldMs, offline: true,
  });
  const call = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const response = await handle(new Request(`http://tessera.test${path}`, {
      method, headers: { "x-tessera-token": TOKEN, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    }));
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  };
  return { runtime, call };
}

describe("the card routes", () => {
  it("asks for, signs, charges and lists a Visa card, with every step on the ledger and the chain intact", async () => {
    const { runtime, call } = offlineApi();
    const asked = await call("POST", "/api/cards", { purpose: "Figma, two editor seats", merchant: "Figma", category: "software", amount: 45, reason: "Design team needs two more editor seats" });
    expect(asked).toMatchObject({ status: 201, json: { state: "PENDING" } });
    const id = asked.json.id as string;
    expect((await call("POST", `/api/cards/${id}/approve`, { note: "ok" })).status).toBe(409);
    expect(await call("POST", `/api/cards/${id}/approve`, { note: "Approved for the design team" })).toMatchObject({ status: 200, json: { state: "ACTIVE" } });
    expect(await call("POST", `/api/cards/${id}/charge`, { amount: 99, merchantCategoryCode: "5734" })).toMatchObject({ json: { state: "ACTIVE" } });
    const checkout = await call("POST", `/api/cards/${id}/checkout`, { amount: 45 });
    expect(checkout.json).toMatchObject({ status: "APPROVED", tap: { ok: true, tag: "agent-payer-auth" } });

    const cards = CardsSchema.parse((await call("GET", "/api/cards")).json);
    expect(cards).toMatchObject({ connected: true, canCharge: true });
    const card = cards.items.find((c) => c.id === id)!;
    // Offline, a charge clears on the bank clock's beat, as on the sandbox: spent once it clears, held until then.
    expect(card).toMatchObject({ state: "SPENT", brand: "VISA", spentMinor: 0, heldMinor: 4_500, approvedBy: "ops@tessera.demo", categoryLabel: "Software and SaaS" });
    expect(card.charges.map((c) => [c.status, c.failureReason])).toEqual([["FAILED", "LIMIT_EXCEEDED"], ["PENDING", null]]);
    expect(card.settlements).toEqual([]);
    expect(card.checkouts).toEqual([expect.objectContaining({ status: "APPROVED", tapVerified: true, kid: cards.agentKeyId })]);
    expect(runtime.ledger.verifyChain().ok).toBe(true);
  });

  it("shows a cleared charge as spent, with its proof against the signed terms", async () => {
    const { call } = offlineApi({ TESSERA_BANK_CLOCK_MS: "0" });
    const id = (await call("POST", "/api/cards", { purpose: "Figma, two editor seats", merchant: "Figma", category: "software", amount: 45, reason: "Design team needs two more editor seats" })).json.id as string;
    await call("POST", `/api/cards/${id}/approve`, { note: "Approved for the design team" });
    await call("POST", `/api/cards/${id}/checkout`, { amount: 45 });
    const card = CardsSchema.parse((await call("GET", "/api/cards")).json).items.find((c) => c.id === id)!;
    expect(card).toMatchObject({ state: "SPENT", spentMinor: 4_500, heldMinor: 0 });
    expect(card.settlements).toEqual([expect.objectContaining({ amountMinor: 4_500, merchant: "Figma", matches: true })]);
  });

  it("publishes the agent's TAP key, and the published key is the one that signed", async () => {
    const { runtime, call } = offlineApi();
    const { keys } = (await call("GET", "/api/tap/keys")).json as { keys: Array<{ kid: string; x: string }> };
    expect(keys).toHaveLength(1);
    expect(keyFromJwk(keys[0]!).export({ format: "jwk" })).toEqual(runtime.cards.agentJwk && keyFromJwk(runtime.cards.agentJwk).export({ format: "jwk" }));
  });

  it("refuses a card above the limit before any person sees it, and says why", async () => {
    const { call } = offlineApi();
    const refused = await call("POST", "/api/cards", { purpose: "A year of everything", merchant: "Figma", category: "software", amount: 9_000, reason: "Paying the whole year up front" });
    expect(refused.json.state).toBe("REFUSED");
    expect(String(refused.json.reasons)).toContain("above the card limit of $2,500.00");
  });
});
