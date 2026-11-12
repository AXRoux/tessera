import { describe, expect, it } from "bun:test";
import { createToolbox, type ToolboxDeps } from "../src/agent/toolbox";
import { Closer } from "../src/closer/closer";
import { Commander } from "../src/commander/commander";
import { SECRET, world, type World } from "./helpers/world";

function toolboxFor(w: World, options: Partial<Pick<ToolboxDeps, "acceptClientText" | "scope">> = {}) {
  const commander = new Commander({ ledger: w.ledger, gateway: w.gateway, balances: w.api, secret: SECRET });
  const closer = new Closer({ ledger: w.ledger, api: w.api, gateway: w.gateway, secret: SECRET, paidHoldMs: 0 });
  return createToolbox({ ledger: w.ledger, gateway: w.gateway, commander, closer, model: null, actor: "agent:test", acceptClientText: false, ...options });
}

// A model reaching for a tool sends the shape it guesses. A run that dies on its second call because the key was `id`
// is a bad demo and a worse integration, so the toolbox accepts the common shapes and says what it wanted when it cannot.
describe("the toolbox tolerates the argument shapes a model reaches for", () => {
  it("accepts incidentId, id, incident_id and a bare id string", async () => {
    const w = world();
    const toolbox = toolboxFor(w);
    for (const args of [{ incidentId: w.obligation.id }, { id: w.obligation.id }, { incident_id: w.obligation.id }, w.obligation.id]) {
      const outcome = await toolbox.call("assess_incident", args);
      expect(outcome.ok).toBe(true);
    }
  });

  it("accepts the human-facing reference, which is what the board shows a person", async () => {
    const w = world();
    const toolbox = toolboxFor(w);
    const outcome = await toolbox.call("assess_incident", { reference: w.obligation.reference });
    expect(outcome.ok).toBe(true);
    expect(JSON.stringify(outcome)).toContain(w.obligation.reference);
  });

  it("accepts an aliased note or reason, and remembers it as the note", async () => {
    const w = world();
    const toolbox = toolboxFor(w);
    const outcome = await toolbox.call("defer_incident", { id: w.obligation.id, reason: "inside the settlement window" });
    expect(outcome.ok).toBe(true);
    const escalation = await toolbox.call("escalate_to_human", { incident: w.obligation.id, note: "a person should look" });
    expect(escalation.ok).toBe(true);
  });

  it("names the accepted keys and echoes what arrived when it still cannot parse the call", async () => {
    const toolbox = toolboxFor(world());
    const outcome = await toolbox.call("replace_payment", { incident: 42 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.kind !== "invalid") throw new Error("expected an invalid outcome");
    expect(outcome.message).toContain("incidentId");
    expect(outcome.message).toContain("received");
    expect(outcome.message).toContain("42");
  });

  it("keeps the scope rule: an id from another run's toolbox is refused with a reason, not a crash", async () => {
    const w = world();
    const other = w.ledger.createObligation({ reference: "INV-2002", beneficiaryId: "ben-A", amountMinor: 5_000, currency: "USD", method: "LOCAL", reason: "professional_business_services" });
    const toolbox = toolboxFor(w, { scope: new Set([w.obligation.id]) });
    const outside = await toolbox.call("assess_incident", { id: other.id });
    expect(outside.ok).toBe(false);
    if (outside.ok || outside.kind !== "invalid") throw new Error("expected an invalid outcome");
    expect(outside.message).toContain("outside the scope");
  });
});
