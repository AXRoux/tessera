import { describe, expect, it } from "bun:test";
import { FakeIssuingApi } from "../src/airwallex/fake-issuing";
import { FakePayoutApi } from "../src/airwallex/fake";
import type { CreateCardRequest } from "../src/airwallex/issuing";
import { AwxHttpError } from "../src/airwallex/types";
import { CardDesk } from "../src/cards/desk";
import { agentKeyFrom, keyFromJwk, newNonce, parseSignatureInput, publicJwk, signObject, signRequest, TapVerifier, verifyObject } from "../src/cards/tap";
import { heldFrom } from "../src/ledger/cards";
import { Ledger } from "../src/ledger/ledger";

const T0 = 1_794_000_000;

function tapRequest(headers: Partial<Record<"Signature-Input" | "Signature", string>>, url = "https://merchant.example/checkout"): Request {
  return new Request(url, { method: "POST", headers: headers as Record<string, string> });
}

describe("Visa Trusted Agent Protocol", () => {
  const key = agentKeyFrom("a secret the instance holds");
  const verifier = () => new TapVerifier((kid) => (kid === key.kid ? key.publicKey : null), () => T0 + 10);

  it("derives a stable Ed25519 agent key and publishes it as a JWK whose id is its thumbprint", () => {
    expect(agentKeyFrom("a secret the instance holds").kid).toBe(key.kid);
    expect(agentKeyFrom("another secret").kid).not.toBe(key.kid);
    const jwk = publicJwk(key);
    expect(jwk).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "Ed25519", use: "sig", kid: key.kid });
    expect(keyFromJwk(jwk).export({ format: "jwk" })).toEqual(key.publicKey.export({ format: "jwk" }));
  });

  it("verifies a signed checkout, then refuses the same nonce a second time", () => {
    const v = verifier();
    const nonce = newNonce();
    const headers = signRequest({ key, authority: "merchant.example", path: "/checkout", tag: "agent-payer-auth", nonce, now: T0 });
    expect(headers["Signature-Input"]).toContain('tag="agent-payer-auth"');
    const first = v.verify(tapRequest(headers), "agent-payer-auth");
    expect(first).toMatchObject({ ok: true, kid: key.kid, tag: "agent-payer-auth", nonce });
    expect(v.verify(tapRequest(headers))).toEqual({ ok: false, reason: "this nonce was already used: a replay" });
  });

  it("refuses a request moved to another path or host, an expired one, a wide window, the wrong tag and an unknown key", () => {
    const sign = (over: Partial<Parameters<typeof signRequest>[0]> = {}) =>
      signRequest({ key, authority: "merchant.example", path: "/checkout", tag: "agent-payer-auth", nonce: newNonce(), now: T0, ...over });
    expect(verifier().verify(tapRequest(sign(), "https://merchant.example/refund"))).toMatchObject({ ok: false, reason: "the signature does not match the request" });
    expect(verifier().verify(tapRequest(sign(), "https://evil.example/checkout"))).toMatchObject({ ok: false, reason: "the signature does not match the request" });
    expect(verifier().verify(tapRequest(sign({ now: T0 - 600 })))).toMatchObject({ ok: false, reason: "the signature has expired" });
    const wide = sign();
    wide["Signature-Input"] = wide["Signature-Input"].replace(/expires=\d+/, `expires=${T0 + 3600}`);
    expect(verifier().verify(tapRequest(wide))).toMatchObject({ ok: false, reason: "created and expires are more than eight minutes apart" });
    expect(verifier().verify(tapRequest(sign({ tag: "agent-browser-auth" })), "agent-payer-auth")).toMatchObject({ ok: false });
    const stranger = agentKeyFrom("not a registered agent");
    expect(verifier().verify(tapRequest(signRequest({ key: stranger, authority: "merchant.example", path: "/checkout", tag: "agent-payer-auth", nonce: newNonce(), now: T0 })))).toMatchObject({
      ok: false,
      reason: `no public key for keyid ${stranger.kid}`,
    });
    expect(verifier().verify(tapRequest({}))).toMatchObject({ ok: false, reason: "no message signature: not a trusted agent" });
  });

  it("reads the Signature-Input layout of Visa's own examples, spaces and all", () => {
    const parsed = parseSignatureInput(
      'sig2=("@authority" "@path"); created=1735689600; keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U"; alg="Ed25519"; expires=1735693200; nonce="e8N7S2MFd/qrd6T2R3tdfAuuANngKI7LFtKYI/vowzk4lAZYadIX6wW25MwG7DCT9RUKAJ0qVkU0mEeLElW1qg=="; tag="agent-browser-auth"',
    );
    expect(parsed?.components).toEqual(["@authority", "@path"]);
    expect(parsed?.params).toMatchObject({ created: 1735689600, expires: 1735693200, alg: "Ed25519", tag: "agent-browser-auth" });
  });

  it("signs a payment container so that any change to it shows", () => {
    const container = signObject(key, { nonce: "n1", paymentToken: "card-1", lastFour: "4242" });
    expect(verifyObject(container, key.publicKey)).toBe(true);
    expect(verifyObject({ ...container, paymentToken: "card-2" }, key.publicKey)).toBe(false);
  });
});

function desk(options: { failCreate?: boolean; clearAfterMs?: number; now?: () => Date } = {}) {
  const ledger = new Ledger(":memory:");
  const payouts = new FakePayoutApi();
  payouts.balances.set("USD", 50_000);
  const issuing = new FakeIssuingApi(payouts.balances, options.now, options.clearAfterMs);
  if (options.failCreate) {
    const create = issuing.createCard.bind(issuing);
    let fail = true;
    issuing.createCard = async (request: CreateCardRequest) => {
      if (fail) {
        fail = false;
        throw new AwxHttpError(400, "invalid_request", "Invalid issuance details", {});
      }
      return create(request);
    };
  }
  const cards = new CardDesk({
    ledger,
    issuing,
    charger: issuing,
    balances: payouts,
    reserveFloorMinor: { USD: 100_000 },
    agentKey: agentKeyFrom("desk secret"),
    now: options.now,
  });
  return { ledger, issuing, payouts, cards };
}

const figma = { purpose: "Figma, two editor seats", merchant: "Figma", category: "software", amount: 45, currency: "USD", reason: "Design team needs two more editor seats this month" };

describe("the card desk", () => {
  it("issues a Visa card only after code allows the request and a person signs it, with the signed terms as its controls", async () => {
    const { cards, issuing, ledger } = desk();
    const asked = await cards.request({ ...figma, requestedBy: "operator:ops@tessera.demo" });
    expect(asked.state).toBe("PENDING");
    const issued = await cards.approve(asked.id, "operator:ops@tessera.demo", "Approved for the design team's seats");
    expect(issued).toMatchObject({ state: "ACTIVE", brand: "VISA", approvedBy: "operator:ops@tessera.demo" });
    expect(issued.last4).toMatch(/^\d{4}$/);
    const remote = await issuing.getCard(issued.awxCardId!);
    expect(remote.authorization_controls).toMatchObject({
      allowed_transaction_count: "SINGLE",
      allowed_currencies: ["USD"],
      allowed_merchant_categories: ["5734", "5817", "5818", "7372"],
    });
    expect(ledger.verifyChain().ok).toBe(true);
  });

  it("refuses what the policy refuses before any person sees it, and never lets an agent sign", async () => {
    const { cards } = desk();
    const big = await cards.request({ ...figma, amount: 1_500, requestedBy: "agent:claude" });
    expect(big.state).toBe("REFUSED");
    expect(big.lastError).toContain("an agent may ask for at most $1,000.00");
    const bad = await cards.request({ ...figma, category: "casino", currency: "JPY", requestedBy: "operator:ops" });
    expect(bad.state).toBe("REFUSED");
    const ok = await cards.request({ ...figma, requestedBy: "agent:claude" });
    await expect(cards.approve(ok.id, "agent:claude", "I approve my own card, obviously")).rejects.toThrow("an agent cannot sign a card");
    await expect(cards.approve(ok.id, "operator:ops", "short")).rejects.toThrow("write a note");
  });

  it("lets Airwallex's controls decline what the card was not signed for, records every decline once, and closes a single-use card after its charge", async () => {
    const { cards, issuing, ledger } = desk();
    const card = await cards.approve((await cards.request({ ...figma, requestedBy: "operator:ops" })).id, "operator:ops", "Approved for the design seats");
    await cards.simulateCharge(card.id, { amount: 60, merchantCategoryCode: "5734" });
    await cards.simulateCharge(card.id, { amount: 20, merchantCategoryCode: "7995" });
    const spent = await cards.simulateCharge(card.id, { amount: 45, merchantCategoryCode: "5734" });
    expect(cards.charges(card.id).map((c) => [c.status, c.failureReason])).toEqual([
      ["FAILED", "LIMIT_EXCEEDED"],
      ["FAILED", "MERCHANT_CATEGORY_NOT_ALLOWED"],
      ["APPROVED", null],
    ]);
    expect(spent).toMatchObject({ state: "SPENT", spentMinor: 4_500 });
    expect((await issuing.getCard(card.awxCardId!)).card_status).toBe("CLOSED");
    await cards.sync();
    expect(cards.charges(card.id)).toHaveLength(3);
    expect(ledger.verifyChain().ok).toBe(true);
  });

  it("pays through Visa TAP only at the merchant a person named, and the merchant verifies the agent before charging", async () => {
    const { cards, ledger } = desk();
    const card = await cards.approve((await cards.request({ ...figma, requestedBy: "agent:claude" })).id, "operator:ops", "Approved for the design seats");
    await expect(cards.agentCheckout(card.id, { amount: 45, merchant: "Canva" }, "agent:claude")).rejects.toThrow("signed for Figma, not Canva");
    const { result, card: after } = await cards.agentCheckout(card.id, { amount: 45, merchant: "figma" }, "agent:claude");
    expect(result).toMatchObject({ status: "APPROVED", reason: null, tap: { ok: true, tag: "agent-payer-auth" } });
    expect(result.orderId).toMatch(/^ORD-/);
    expect(after.state).toBe("SPENT");
    const checkout = ledger.events().find((e) => e.type === "CARD_CHECKOUT");
    expect(checkout?.payload).toMatchObject({ actor: "agent:claude", status: "APPROVED", tap: { verified: true } });
    await expect(cards.agentCheckout(card.id, { amount: 45, merchant: "Figma" }, "agent:claude")).rejects.toThrow("only an active card can pay");
  });

  it("treats a CLEARING as accepted and proves it at once, then follows Airwallex until it posts, under the same id", async () => {
    let now = Date.parse("2026-11-14T12:00:00Z");
    const { cards, ledger, payouts } = desk({ clearAfterMs: 30 * 60_000, now: () => new Date(now) });
    const card = await cards.approve((await cards.request({ ...figma, requestedBy: "agent:claude" })).id, "operator:ops", "Approved for the design seats");
    const { card: paid } = await cards.agentCheckout(card.id, { amount: 45, merchant: "Figma" }, "agent:claude");
    // The builder guide: a clearing can stay PENDING longer than a demo; treat the CLEARING as accepted.
    expect(payouts.balances.get("USD")).toBe(50_000 - 45);
    expect(paid).toMatchObject({ state: "SPENT", spentMinor: 4_500 });
    expect(cards.charges(card.id)).toEqual([expect.objectContaining({ type: "CLEARING", status: "PENDING", amountMinor: 4_500 })]);
    const [proof] = cards.settlements(card.id);
    expect(proof).toMatchObject({ amountMinor: 4_500, currency: "USD", merchant: "Figma", mcc: "5734", matches: true });
    expect(proof!.checks.map((c) => c.check)).toEqual(["merchant", "cap", "category", "currency", "single_use", "signed"]);

    now += 31 * 60_000;
    await cards.sync();
    expect(ledger.requireCard(card.id)).toMatchObject({ state: "SPENT", spentMinor: 4_500 });
    expect(cards.charges(card.id)).toEqual([expect.objectContaining({ status: "APPROVED", amountMinor: 4_500 })]);
    expect(cards.settlements(card.id)).toHaveLength(1);

    const events = ledger.events().length;
    await cards.sync();
    expect(ledger.events().length).toBe(events);
    expect(ledger.events().filter((e) => e.type === "CARD_CHARGE").map((e) => (e.payload as { status: string }).status)).toEqual(["PENDING", "APPROVED"]);
    expect(ledger.verifyChain().ok).toBe(true);
  });

  it("counts a charge an earlier build stored as Airwallex's negative PENDING amount by its size, and follows it to APPROVED", async () => {
    const { cards, ledger } = desk();
    const card = await cards.approve((await cards.request({ ...figma, requestedBy: "operator:ops" })).id, "operator:ops", "Approved for the design seats");
    const base = { transactionId: "tx-1", cardId: card.id, type: "CLEARING", currency: "USD", merchant: "Figma", mcc: "5734", failureReason: null, at: "2026-11-13T21:00:59Z" };
    ledger.recordCardCharge({ ...base, status: "PENDING", amountMinor: -4_500 });
    expect(ledger.requireCard(card.id).spentMinor).toBe(4_500);
    expect(ledger.recordCardCharge({ ...base, status: "APPROVED", amountMinor: 4_500 })).toBe(true);
    expect(ledger.recordCardCharge({ ...base, status: "APPROVED", amountMinor: 4_500 })).toBe(false);
    expect(ledger.requireCard(card.id).spentMinor).toBe(4_500);
    expect(ledger.verifyChain().ok).toBe(true);
  });

  it("counts a two-phase charge once: the authorisation is held until its clearing, then the clearing is spent", async () => {
    const { cards, ledger } = desk();
    const card = await cards.approve((await cards.request({ ...figma, requestedBy: "operator:ops" })).id, "operator:ops", "Approved for the design seats");
    const base = { cardId: card.id, currency: "USD", merchant: "Figma", mcc: "5734", failureReason: null, at: "2026-11-14T12:00:00Z" };
    ledger.recordCardCharge({ ...base, transactionId: "auth-1", type: "AUTHORIZATION", status: "APPROVED", amountMinor: -4_000 });
    expect([ledger.requireCard(card.id).spentMinor, heldFrom(cards.charges(card.id))]).toEqual([0, 4_000]);
    ledger.recordCardCharge({ ...base, transactionId: "clear-1", type: "CLEARING", status: "PENDING", amountMinor: -4_000 });
    expect([ledger.requireCard(card.id).spentMinor, heldFrom(cards.charges(card.id))]).toEqual([4_000, 0]);
    await cards.sync();
    expect(cards.settlements(card.id)).toEqual([expect.objectContaining({ transactionId: "clear-1", matches: true })]);
  });

  it("flags a cleared charge from a merchant the person did not name, even though the card's controls let it through", async () => {
    const { cards } = desk();
    const card = await cards.approve((await cards.request({ ...figma, requestedBy: "operator:ops" })).id, "operator:ops", "Approved for the design seats");
    await cards.simulateCharge(card.id, { amount: 30, merchantCategoryCode: "5734", merchant: "Canva" });
    const [proof] = cards.settlements(card.id);
    expect(proof?.matches).toBe(false);
    expect(proof?.checks.find((c) => c.check === "merchant")).toEqual({ check: "merchant", ok: false, detail: "charged by Canva, but signed for Figma" });
    expect(proof?.checks.filter((c) => !c.ok)).toHaveLength(1);
  });

  it("keeps a card Airwallex refused as FAILED with Airwallex's words, and issues it on a retry with a fresh request id", async () => {
    const { cards, ledger } = desk({ failCreate: true });
    const asked = await cards.request({ ...figma, requestedBy: "operator:ops" });
    const failed = await cards.approve(asked.id, "operator:ops", "Approved for the design seats");
    expect(failed).toMatchObject({ state: "FAILED", lastError: "invalid_request: Invalid issuance details" });
    const retried = await cards.retry(asked.id, "operator:ops");
    expect(retried.state).toBe("ACTIVE");
    expect(retried.requestId).not.toBe(asked.requestId);
    expect(ledger.verifyChain().ok).toBe(true);
  });

  it("notices a card row edited behind the ledger's back", async () => {
    const { cards, ledger } = desk();
    const card = await cards.approve((await cards.request({ ...figma, requestedBy: "operator:ops" })).id, "operator:ops", "Approved for the design seats");
    ledger.db.query("UPDATE cards SET amountMinor = 999900 WHERE id = ?").run(card.id);
    expect(ledger.verifyChain()).toMatchObject({ ok: false, reason: `card ${card.id} has amountMinor 999900 in its table but 4500 by its events` });
  });
});
