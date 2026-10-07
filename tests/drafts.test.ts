import { describe, expect, it } from "bun:test";
import { createToolbox } from "../src/agent/toolbox";
import { checkDraftText, pendingDraft } from "../src/commander/drafts";
import { Closer } from "../src/closer/closer";
import { Commander } from "../src/commander/commander";
import { createApi } from "../src/server/api";
import { IncidentViewSchema } from "../src/server/wire";
import { approve, killedAttempt, SECRET, world, type World } from "./helpers/world";

const GOOD = "Thanks for getting in touch. Your payment is still within its normal processing window and has not failed. We will confirm as soon as the bank reports it as delivered.";

describe("what a supplier reply may contain", () => {
  it("accepts plain, factual prose, including a date", () => {
    expect(checkDraftText(GOOD)).toBeNull();
    expect(checkDraftText("We checked on 2026-10-07 and the transfer is still being processed by the bank, as expected.")).toBeNull();
  });

  it.each([
    ["an IBAN", "Please use our updated details: GB82 WEST 1234 5698 7654 32 for the transfer today."],
    ["a long number", "Your reference is 4420915738 and the status is processing at the bank today."],
    ["a link", "You can check the status at https://pay.example.com/status for the latest news today."],
    ["an email address", "Please write to billing@supplier-payments.example if you need anything more today."],
    ["a promise of another payment", "We are sorry for the delay and will resend the payment to you by tomorrow morning."],
    ["a promise of a replacement", "A replacement will go out today, so please disregard the earlier transfer entirely."],
    ["a second payment", "We will make a second payment as soon as our team approves it this afternoon."],
    ["too little", "Hi there."],
  ])("refuses %s", (_name, text) => {
    expect(checkDraftText(text)).not.toBeNull();
  });

  it("refuses a message over 900 characters", () => {
    expect(checkDraftText("a sentence that is fine. ".repeat(60))).toContain("900");
  });
});

function rig() {
  const w = world();
  const commander = new Commander({ ledger: w.ledger, gateway: w.gateway, balances: w.api, secret: SECRET });
  const closer = new Closer({ ledger: w.ledger, api: w.api, secret: SECRET, paidHoldMs: 0 });
  const toolbox = createToolbox({ ledger: w.ledger, gateway: w.gateway, commander, closer, model: null, actor: "agent:test" });
  return { w, toolbox, commander, closer };
}

async function inFlight(w: World): Promise<void> {
  await w.gateway.submit(approve(w.obligation));
}

describe("draft_supplier_reply", () => {
  it("records a draft with facts written by code, and nothing is sent", async () => {
    const { w, toolbox } = rig();
    await inFlight(w);

    const outcome = await toolbox.call("draft_supplier_reply", { incidentId: w.obligation.id, kind: "STATUS", message: GOOD });

    expect(outcome.ok).toBe(true);
    const draft = pendingDraft(w.ledger.events(w.obligation.id))!;
    expect(draft).toMatchObject({ actor: "agent:test", kind: "STATUS", message: GOOD });
    expect(draft.facts[0]).toContain("INV-1001");
    expect(draft.facts[0]).toContain("$100.00");
    expect(draft.facts[1]).toContain(w.ledger.latestAttempt(w.obligation.id)!.transferId!.slice(0, 8));
    expect(w.api.all).toHaveLength(1);
  });

  it("refuses a kind the Commander has not allowed", async () => {
    const { w, toolbox } = rig();
    await inFlight(w);

    const outcome = await toolbox.call("draft_supplier_reply", { incidentId: w.obligation.id, kind: "PROOF", message: GOOD });

    expect(outcome).toMatchObject({ ok: false, kind: "refused", error: "DraftRejected" });
    expect(pendingDraft(w.ledger.events(w.obligation.id))).toBeNull();
  });

  it("refuses text that carries account details or promises another payment, and says why", async () => {
    const { w, toolbox } = rig();
    await inFlight(w);

    const iban = await toolbox.call("draft_supplier_reply", {
      incidentId: w.obligation.id, kind: "STATUS", message: "Please send any queries to our new account GB82 WEST 1234 5698 7654 32 today.",
    });
    const promise = await toolbox.call("draft_supplier_reply", {
      incidentId: w.obligation.id, kind: "STATUS", message: "We apologise and will resend the payment to you straight away today.",
    });

    expect(iban).toMatchObject({ ok: false, kind: "refused", message: expect.stringContaining("IBAN") });
    expect(promise).toMatchObject({ ok: false, kind: "refused", message: expect.stringContaining("promise another payment") });
    expect(pendingDraft(w.ledger.events(w.obligation.id))).toBeNull();
  });

  it("allows a correction request after a failure that needs changed details", async () => {
    const { w, toolbox } = rig();
    await killedAttempt(w, "90101"); // INVALID_ACCOUNT_NAME_OR_NUMBER

    const outcome = await toolbox.call("draft_supplier_reply", {
      incidentId: w.obligation.id, kind: "CORRECTION",
      message: "Our bank could not match the account name and number you gave us. Could you confirm your details by phone with our finance team?",
    });

    expect(outcome.ok).toBe(true);
  });

  it("lets a newer draft supersede an older one, and a resolved draft stops being pending", async () => {
    const { w, toolbox } = rig();
    await inFlight(w);
    await toolbox.call("draft_supplier_reply", { incidentId: w.obligation.id, kind: "STATUS", message: GOOD });
    await toolbox.call("draft_supplier_reply", { incidentId: w.obligation.id, kind: "STATUS", message: GOOD.replace("Thanks", "Many thanks") });

    const newest = pendingDraft(w.ledger.events(w.obligation.id))!;
    expect(newest.message.startsWith("Many thanks")).toBe(true);

    w.ledger.append(w.obligation.id, "DRAFT_RESOLVED", { draftSeq: newest.seq, resolution: "DISCARDED", by: "ops" });
    expect(pendingDraft(w.ledger.events(w.obligation.id))).toBeNull();
  });
});

describe("resolving a draft over the API", () => {
  function api() {
    const { w, toolbox, commander, closer } = rig();
    const handle = createApi({
      ledger: w.ledger, gateway: w.gateway, commander, closer, model: null, simulator: null,
      token: "t".repeat(24), operator: "ops@acme.example", beneficiaryId: "ben-A", paidHoldMs: 0,
    });
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await handle(new Request(`http://api.test${path}`, {
        method, headers: { "content-type": "application/json", "x-tessera-token": "t".repeat(24) }, body: body === undefined ? undefined : JSON.stringify(body),
      }));
      return { status: response.status, json: await response.json() as unknown };
    };
    return { w, toolbox, call };
  }

  it("shows the pending draft on the incident, and a person marks it sent under their own name", async () => {
    const { w, toolbox, call } = api();
    await inFlight(w);
    await toolbox.call("draft_supplier_reply", { incidentId: w.obligation.id, kind: "STATUS", message: GOOD });

    const before = IncidentViewSchema.parse((await call("GET", `/api/obligations/${w.obligation.id}`)).json);
    expect(before.draft).toMatchObject({ kind: "STATUS", actor: "agent:test" });

    const resolved = await call("POST", `/api/obligations/${w.obligation.id}/drafts/resolve`, { draftSeq: before.draft!.seq, resolution: "SENT" });
    expect(resolved.status).toBe(200);

    const after = IncidentViewSchema.parse((await call("GET", `/api/obligations/${w.obligation.id}`)).json);
    expect(after.draft).toBeNull();
    const event = w.ledger.events(w.obligation.id).findLast((e) => e.type === "DRAFT_RESOLVED")!;
    expect(event.payload).toMatchObject({ resolution: "SENT", by: "ops@acme.example" });
  });

  it("refuses to resolve a draft that is not the one waiting", async () => {
    const { w, toolbox, call } = api();
    await inFlight(w);
    await toolbox.call("draft_supplier_reply", { incidentId: w.obligation.id, kind: "STATUS", message: GOOD });

    const stale = await call("POST", `/api/obligations/${w.obligation.id}/drafts/resolve`, { draftSeq: 999, resolution: "SENT" });

    expect(stale.status).toBe(409);
  });
});
