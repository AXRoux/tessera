import { describe, expect, it } from "bun:test";
import failureCodes from "../fixtures/failure-codes.json";
import { FakePayoutApi } from "../src/airwallex/fake";
import { BankClock } from "../src/server/bank-clock";
import { Closer } from "../src/closer/closer";
import { Commander } from "../src/commander/commander";
import { checkIntake, domainOf } from "../src/commander/intake";
import { DEFAULT_POLICY } from "../src/commander/policy";
import { dueDate, fill, invoiceTotal, SUPPLIERS, supplierById } from "../src/demo/suppliers";
import { PayoutGateway } from "../src/gateway/gateway";
import { Ledger } from "../src/ledger/ledger";
import { formatMinor } from "../src/money";
import { createApi, type Simulator } from "../src/server/api";
import { isStoryInvoice } from "../src/server/requests";
import { IncidentListSchema, IncidentViewSchema, RequestListSchema, SupplierRequestSchema, SuppliersSchema } from "../src/server/wire";

const TOKEN = "operator-token-for-tests";
const SECRET = "test-secret-test-secret-test-secret-32";

/** The sandbox simulator as the fake plays it: FAILED flips to CANCELLED straight away, carrying the failure code. */
function simulatorFor(api: FakePayoutApi): Simulator {
  return {
    async advance(transferId, status, failureType) {
      if (status !== "FAILED") return api.advance(transferId, status);
      const code = failureCodes.find((row) => row.failureType === failureType)?.code;
      api.advance(transferId, "FAILED", code);
      api.advance(transferId, "CANCELLED", code);
    },
  };
}

function rig(options: { production?: boolean } = {}) {
  const ledger = new Ledger(":memory:");
  const api = new FakePayoutApi();
  const gateway = new PayoutGateway({ ledger, api, approvalSecret: SECRET });
  const commander = new Commander({ ledger, gateway, balances: api, secret: SECRET, policy: { ...DEFAULT_POLICY, paidHoldMs: 0 } });
  const closer = new Closer({ ledger, api, gateway, secret: SECRET, paidHoldMs: 0 });
  const handle = createApi({
    ledger, gateway, commander, closer, model: null, simulator: options.production ? null : simulatorFor(api),
    token: TOKEN, operator: "ops@acme.example", beneficiaryId: "ben-default", paidHoldMs: 0, beneficiaries: api, storyPollMs: 0,
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await handle(
      new Request(`http://api.test${path}`, { method, headers: { "content-type": "application/json", "x-tessera-token": TOKEN }, body: body === undefined ? undefined : JSON.stringify(body) }),
    );
    return { status: response.status, data: (await response.json().catch(() => null)) as Record<string, unknown> };
  };
  const send = async (supplierId: string) => SupplierRequestSchema.parse((await call("POST", "/api/requests", { supplierId })).data);
  const approve = async (requestId: string) => {
    const r = await call("POST", `/api/requests/${requestId}/approve`, { note: "Checked against the vendor record and the invoice." });
    expect(r.status).toBe(201);
    return String(r.data.obligationId);
  };
  const view = async (id: string) => IncidentViewSchema.parse((await call("GET", `/api/obligations/${id}`)).data);
  const play = (id: string, step: string) => call("POST", `/api/obligations/${id}/story/play`, { step });
  const next = async (id: string) => (await view(id)).story!.steps.find((s) => s.state === "next")?.id ?? null;
  /** Transfers at the fake bank for one reference that are live or paid: never more than one. */
  const liveTransfers = (reference: string) => [...api.transfers.values()].filter((t) => t.reference === reference && t.status !== "CANCELLED").length;
  return { ledger, api, gateway, call, send, approve, view, play, next, liveTransfers };
}

const honest = SUPPLIERS.filter((s) => s.story !== "impostor");

describe("the door (intake)", () => {
  const judge = (supplierId: string, existing: { id: string; status: string } | null = null) => {
    const s = supplierById(supplierId)!;
    const values = { ref: `${s.invoicePrefix}-${s.invoiceBase}`, amount: formatMinor(invoiceTotal(s), "USD"), due: dueDate(new Date(), s.dueInDays) };
    return checkIntake(
      { sender: s.request.from, subject: fill(s.request.subject, values), body: fill(s.request.body, values), reference: values.ref, amountMinor: invoiceTotal(s), currency: "USD" },
      { vendor: s, existing, maxAmountMinor: 100_000 },
    );
  };

  it("lets every honest supplier's invoice through, and none of their follow-ups reads as a bank change or an instruction", () => {
    for (const s of honest) {
      const result = judge(s.id);
      expect({ id: s.id, verdict: result.verdict, failed: result.checks.filter((c) => !c.ok).map((c) => c.id) }).toEqual({ id: s.id, verdict: "PAYABLE", failed: [] });
      if (s.followUp) {
        const values = { ref: "X-1", amount: "$1.00", due: "1 Jan" };
        const text = `${fill(s.followUp.subject, values)}\n${fill(s.followUp.body, values)}`;
        const r = checkIntake({ sender: s.followUp.from, subject: "", body: text, reference: "X-1", amountMinor: 100, currency: "USD" }, { vendor: s, existing: null, maxAmountMinor: 100_000 });
        expect(r.checks.filter((c) => c.id === "payee" || c.id === "instructions").every((c) => c.ok)).toBe(true);
      }
    }
  });

  it("holds the impostor: a look-alike domain, new bank details and an instruction for an assistant", () => {
    const result = judge("framer");
    expect(result.verdict).toBe("HELD");
    expect(result.checks.filter((c) => !c.ok).map((c) => c.id).sort()).toEqual(["instructions", "payee", "sender"]);
  });

  it("never opens an invoice that is already on the ledger", () => {
    expect(judge("modal", { id: "o-1", status: "OPEN" }).verdict).toBe("DUPLICATE");
  });

  it("trusts the vendor's domain and its subdomains, never a domain that only contains it", () => {
    const vendor = { name: "Modal", legalName: "Modal Labs, Inc.", domain: "modal.com" };
    const at = (sender: string) => checkIntake({ sender, subject: "MDL-1 $10.00", body: "", reference: "MDL-1", amountMinor: 1_000, currency: "USD" }, { vendor, existing: null, maxAmountMinor: 100_000 });
    expect(at("billing@modal.com").checks[0]!.ok).toBe(true);
    expect(at("billing@eu.modal.com").checks[0]!.ok).toBe(true);
    expect(at("billing@modal.com.evil.io").checks[0]!.ok).toBe(false);
    expect(at("billing@notmodal.com").checks[0]!.ok).toBe(false);
    expect(domainOf("no address")).toBe("");
  });

  it("holds an invoice whose email does not state its own amount, or one over the payout limit", () => {
    const vendor = { name: "Modal", legalName: "Modal Labs, Inc.", domain: "modal.com" };
    const quiet = checkIntake({ sender: "billing@modal.com", subject: "MDL-1", body: "Please pay MDL-1.", reference: "MDL-1", amountMinor: 1_000, currency: "USD" }, { vendor, existing: null, maxAmountMinor: 100_000 });
    expect(quiet.verdict).toBe("HELD");
    const big = checkIntake({ sender: "billing@modal.com", subject: "MDL-1", body: "MDL-1 for $2,000.00", reference: "MDL-1", amountMinor: 200_000, currency: "USD" }, { vendor, existing: null, maxAmountMinor: 100_000 });
    expect(big.checks.find((c) => c.id === "limit")!.ok).toBe(false);
  });
});

describe("supplier requests", () => {
  it("lists every supplier on file with the invoice it would send next", async () => {
    const r = rig();
    const list = SuppliersSchema.parse((await r.call("GET", "/api/suppliers")).data);
    expect(list.rehearsal).toBe(true);
    expect(list.suppliers.map((s) => s.id)).toEqual(SUPPLIERS.map((s) => s.id));
    expect(list.suppliers.find((s) => s.id === "modal")!.nextReference).toBe("MDL-2611");
    await r.send("modal");
    expect(SuppliersSchema.parse((await r.call("GET", "/api/suppliers")).data).suppliers.find((s) => s.id === "modal")!.nextReference).toBe("MDL-2612");
  });

  it("opens and pays an approved request to the supplier's own Airwallex payee, and only once", async () => {
    const r = rig();
    const request = await r.send("modal");
    expect(request.status).toBe("RECEIVED");
    expect((await r.call("POST", `/api/requests/${request.id}/approve`, { note: "ok" })).status).toBe(400);

    const id = await r.approve(request.id);
    const v = await r.view(id);
    const payee = (await r.api.listBeneficiaries()).find((b) => b.nickname === "tessera-supplier-modal");
    expect(payee).toBeDefined();
    expect(v.obligation.beneficiaryId).toBe(payee!.id);
    expect(v.obligation.amountMinor).toBe(64_218);
    expect(v.attempts).toHaveLength(1);
    // The bank accepted it at once, so the story (not the bank clock) plays what happens next.
    expect(v.attempts[0]!.awxStatus).toBe("SENT");
    expect(v.inbox).toHaveLength(1);
    expect(v.events.map((e) => e.type)).toContain("REQUEST_APPROVED");
    expect(v.story!.supplier.name).toBe("Modal");

    const again = await r.call("POST", `/api/requests/${request.id}/approve`, { note: "Approving the same invoice twice." });
    expect(again.status).toBe(409);
    expect(r.ledger.listObligations()).toHaveLength(1);
    const list = IncidentListSchema.parse((await r.call("GET", "/api/obligations")).data);
    expect(list.items[0]!.supplier?.id).toBe("modal");
    expect(r.ledger.verifyChain().ok).toBe(true);
  });

  it("holds the impostor at the door: it cannot be approved, opens nothing, and a person can decline it", async () => {
    const r = rig();
    const request = await r.send("framer");
    expect(request.status).toBe("HELD");
    expect((await r.call("POST", `/api/requests/${request.id}/approve`, { note: "Paying the new account they sent." })).status).toBe(409);
    expect(r.ledger.listObligations()).toHaveLength(0);
    const declined = await r.call("POST", `/api/requests/${request.id}/decline`, { note: "Not from framer.com; reported to security." });
    expect(SupplierRequestSchema.parse(declined.data).status).toBe("DECLINED");
    expect(r.ledger.verifyChain().ok).toBe(true);
  });

  it("refuses rehearsals and story steps where there is no simulator (production)", async () => {
    const r = rig({ production: true });
    expect(SuppliersSchema.parse((await r.call("GET", "/api/suppliers")).data).rehearsal).toBe(false);
    expect((await r.call("POST", "/api/requests", { supplierId: "modal" })).status).toBe(403);
  });
});

describe("stories", () => {
  it("timeout: waits while in flight, replaces once the bank proves the money is back, refuses a second press, certifies", async () => {
    const r = rig();
    const id = await r.approve((await r.send("modal")).id);
    expect(await r.next(id)).toBe("chase");
    // Out of order: the bank cannot fail it before the supplier has chased.
    expect((await r.play(id, "fail")).status).toBe(409);

    expect((await r.play(id, "chase")).status).toBe(200);
    let v = await r.view(id);
    expect(v.inbox).toHaveLength(2);
    expect(v.assessment!.decision.recommended).toBe("WAIT");
    expect(v.assessment!.decision.blocked.map((b) => b.action)).toContain("REPLACE");
    expect((await r.play(id, "chase")).status).toBe(409);

    expect((await r.play(id, "fail")).status).toBe(200);
    v = await r.view(id);
    expect(v.attempts[0]!.state).toBe("DEAD");
    expect(v.assessment!.decision.allowed).toContain("REPLACE");
    expect(await r.next(id)).toBe("replace");

    expect((await r.call("POST", `/api/obligations/${id}/replace`)).status).toBe(201);
    expect(await r.next(id)).toBe("retry");
    expect((await r.call("POST", `/api/obligations/${id}/replace`)).status).toBe(409);
    expect(await r.next(id)).toBe("pay");

    expect((await r.play(id, "pay")).status).toBe(200);
    expect(await r.next(id)).toBe("certify");
    expect((await r.call("POST", `/api/obligations/${id}/close`)).status).toBe(200);
    v = await r.view(id);
    expect(v.story!.steps.filter((s) => s.state === "next")).toHaveLength(0);
    expect(v.story!.steps.at(-1)!.state).toBe("yours");
    expect(r.liveTransfers(v.obligation.reference)).toBe(1);
    expect(r.ledger.verifyChain().ok).toBe(true);
  });

  it("inflight: a resend while the first transfer moves is refused, and the first one lands", async () => {
    const r = rig();
    const id = await r.approve((await r.send("primeintellect")).id);
    await r.play(id, "chase");
    expect((await r.call("POST", `/api/obligations/${id}/replace`)).status).toBe(409);
    expect(await r.next(id)).toBe("pay");
    await r.play(id, "pay");
    const v = await r.view(id);
    expect(v.attempts).toHaveLength(1);
    expect(v.attempts[0]!.state).toBe("PAID");
  });

  it("returned: a duplication return goes to a person, and replacing is refused", async () => {
    const r = rig();
    const id = await r.approve((await r.send("langchain")).id);
    await r.play(id, "fail");
    const v = await r.view(id);
    expect(v.assessment!.decision.allowed).not.toContain("REPLACE");
    expect((await r.call("POST", `/api/obligations/${id}/replace`)).status).toBe(409);
    expect((await r.view(id)).story!.steps.at(-1)!.state).toBe("yours");
  });

  it("reminder: the second copy is matched to the invoice on the ledger, filed with it, and never opened", async () => {
    const r = rig();
    const id = await r.approve((await r.send("replicate")).id);
    await r.play(id, "resend");
    const requests = RequestListSchema.parse((await r.call("GET", "/api/requests")).data).items;
    expect(requests.map((q) => q.status)).toEqual(["DUPLICATE", "OPENED"]);
    expect(requests[0]!.obligationId).toBe(id);
    expect(r.ledger.listObligations()).toHaveLength(1);
    expect((await r.view(id)).inbox).toHaveLength(2);
    await r.play(id, "pay");
    expect((await r.call("POST", `/api/obligations/${id}/close`)).status).toBe(200);
    expect(r.ledger.verifyChain().ok).toBe(true);
  });

  it("missing: once paid, a claim that it never arrived cannot buy a second payment", async () => {
    const r = rig();
    const id = await r.approve((await r.send("fal")).id);
    await r.play(id, "pay");
    await r.play(id, "chase");
    const v = await r.view(id);
    expect(v.assessment!.decision.allowed).not.toContain("REPLACE");
    expect((await r.call("POST", `/api/obligations/${id}/replace`)).status).toBe(409);
    expect(await r.next(id)).toBeNull();
    expect(r.liveTransfers(v.obligation.reference)).toBe(1);
  });

  it("refuses to play a person's move, an unknown step, or a story step without a simulator", async () => {
    const r = rig();
    const id = await r.approve((await r.send("modal")).id);
    expect((await r.play(id, "nope")).status).toBe(409);
    await r.play(id, "chase");
    await r.play(id, "fail");
    expect((await r.play(id, "replace")).status).toBe(409);
  });

  it("the bank clock leaves story invoices to their story", async () => {
    const r = rig();
    const id = await r.approve((await r.send("modal")).id);
    await r.play(id, "chase");
    await r.play(id, "fail");
    await r.call("POST", `/api/obligations/${id}/replace`);
    expect(isStoryInvoice(r.ledger, id)).toBe(true);
    const advanced: string[] = [];
    const clock = new BankClock({
      ledger: r.ledger, gateway: r.gateway, afterMs: 0, now: () => Date.now() + 60_000,
      simulator: { advance: async (transferId) => void advanced.push(transferId) }, skip: (o) => isStoryInvoice(r.ledger, o),
    });
    expect(await clock.tick()).toEqual([]);
    expect(advanced).toEqual([]);
  });
});

describe("stories, paid by single-use Visa card", () => {
  it("timeout: after the bank fails it, the invoice is paid by a signed card through Visa TAP, a transfer is refused, and it certifies", async () => {
    const { buildRuntime } = await import("../src/server/runtime");
    const runtime = buildRuntime({ TESSERA_OFFLINE: "1", TESSERA_BANK_CLOCK_MS: "1", TESSERA_PAID_HOLD_MS: "0" });
    const handle = createApi({
      ledger: runtime.ledger, gateway: runtime.gateway, commander: runtime.commander, closer: runtime.closer, cards: runtime.cards,
      model: null, simulator: runtime.simulator, token: TOKEN, operator: "ops@acme.example", beneficiaryId: "offline-us-supplier",
      paidHoldMs: runtime.paidHoldMs, offline: true, beneficiaries: runtime.api, storyPollMs: 0,
    });
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await handle(new Request(`http://api.test${path}`, { method, headers: { "content-type": "application/json", "x-tessera-token": TOKEN }, body: body === undefined ? undefined : JSON.stringify(body) }));
      return { status: response.status, data: (await response.json().catch(() => null)) as Record<string, unknown> };
    };
    const view = async (id: string) => IncidentViewSchema.parse((await call("GET", `/api/obligations/${id}`)).data);
    const next = async (id: string) => (await view(id)).story!.steps.find((s) => s.state === "next")?.id ?? null;

    const request = SupplierRequestSchema.parse((await call("POST", "/api/requests", { supplierId: "modal" })).data);
    const id = String((await call("POST", `/api/requests/${request.id}/approve`, { note: "Checked against the vendor record." })).data.obligationId);
    await call("POST", `/api/obligations/${id}/story/play`, { step: "chase" });
    await call("POST", `/api/obligations/${id}/story/play`, { step: "fail" });
    let v = await view(id);
    expect(v.assessment!.decision.allowed).toEqual(expect.arrayContaining(["REPLACE", "PAY_BY_CARD"]));
    expect(v.story!.steps.find((s) => s.id === "replace")!.alt).toBe("card");

    expect((await call("POST", `/api/obligations/${id}/card`, {})).status).toBe(201);
    expect(await next(id)).toBe("card-sign");
    v = await view(id);
    expect((await call("POST", `/api/cards/${v.invoiceCard!.id}/approve`, { note: "Supplier takes card for this invoice." })).status).toBe(200);
    expect(await next(id)).toBe("card-pay");
    expect((await call("POST", `/api/obligations/${id}/card/pay`, {})).data.outcome).toBe("PAID");

    // The charge clears on the simulator's clock; the sweep reads it back and proves it against the signed terms.
    await Bun.sleep(20);
    await runtime.cards.sync();
    expect(await next(id)).toBe("retry");
    expect((await call("POST", `/api/obligations/${id}/replace`)).status).toBe(409);
    expect(await next(id)).toBe("certify");
    expect((await call("POST", `/api/obligations/${id}/close`)).status).toBe(200);
    v = await view(id);
    expect(v.attempts).toHaveLength(1);
    expect(v.attempts[0]!.state).toBe("DEAD");
    expect(v.invoiceCard!.spentMinor).toBe(64_218);
    expect(v.story!.steps.at(-1)!.state).toBe("yours");
    expect(runtime.ledger.verifyChain().ok).toBe(true);
  });
});
