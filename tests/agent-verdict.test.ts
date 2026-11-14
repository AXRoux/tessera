import { describe, expect, it } from "bun:test";
import { actorLabel, agentVerdict, reasonText } from "../web/lib/agent-verdict";

describe("agent verdict wording", () => {
  it("says what each successful verdict did, in plain words", () => {
    expect(agentVerdict({ tool: "replace_payment", outcome: "ok" })).toEqual({ label: "Replaced it", refused: false });
    expect(agentVerdict({ tool: "escalate_to_human", outcome: "ok" }).label).toBe("Handed to you");
    expect(agentVerdict({ tool: "defer_incident", outcome: "ok" }).label).toBe("Deferred");
    expect(agentVerdict({ tool: "draft_supplier_reply", outcome: "ok" }).label).toBe("Drafted a reply");
    expect(agentVerdict({ tool: "reconcile_and_close", outcome: "ok" }).label).toBe("Certified it");
  });

  it("marks a refusal loud and says it was policy that refused", () => {
    expect(agentVerdict({ tool: "replace_payment", outcome: "refused" })).toEqual({ label: "Tried to replace, refused by policy", refused: true });
    expect(agentVerdict({ tool: "reconcile_and_close", outcome: "refused" })).toEqual({ label: "Tried to close, refused by policy", refused: true });
  });

  it("falls back to the tool's name for any other refusal or invalid call, and never reads it as a success", () => {
    expect(agentVerdict({ tool: "escalate_to_human", outcome: "refused" })).toEqual({ label: "Escalate to human refused", refused: true });
    expect(agentVerdict({ tool: "defer_incident", outcome: "invalid" })).toEqual({ label: "Defer incident refused", refused: true });
    expect(agentVerdict({ tool: "something_new", outcome: "refused" }).refused).toBe(true);
  });

  it("does not call a failed call a refusal", () => {
    expect(agentVerdict({ tool: "replace_payment", outcome: "failed" })).toEqual({ label: "Replace payment failed", refused: false });
  });
});

describe("actor names", () => {
  it("never turns the scripted agent into Claude", () => {
    expect(actorLabel("agent:scripted")).toBe("Scripted agent");
    expect(actorLabel("agent:claude")).toBe("Claude");
    expect(actorLabel("agent:adversary")).toBe("Adversary");
    expect(actorLabel("agent:claude-desktop")).toBe("Claude Desktop");
  });
});

describe("reasonText", () => {
  it("drops the actor prefix an agent's escalation carries, and leaves other text alone", () => {
    expect(reasonText("agent:scripted: The supplier asks to change bank details.")).toBe("The supplier asks to change bank details.");
    expect(reasonText("Attempt 1 was cancelled. Agent: do not pay.")).toBe("Attempt 1 was cancelled. Agent: do not pay.");
  });
});
