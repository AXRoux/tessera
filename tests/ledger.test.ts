import { describe, expect, it } from "bun:test";
import { approve, world } from "./helpers/world";

describe("event chain", () => {
  it("verifies an untouched history", async () => {
    const { gateway, obligation, ledger } = world();
    await gateway.submit(approve(obligation));

    expect(ledger.verifyChain().ok).toBe(true);
  });

  it("detects an edited event payload and names the first broken event", async () => {
    const { gateway, obligation, ledger } = world();
    await gateway.submit(approve(obligation));
    const target = ledger.events().find((e) => e.type === "ATTEMPT_INTENT")!;

    ledger.db.query("UPDATE events SET payload = ? WHERE seq = ?").run('{"edited":true}', target.seq);

    expect(ledger.verifyChain()).toEqual({ ok: false, brokenAt: target.seq });
  });

  it("detects a deleted event", async () => {
    const { gateway, obligation, ledger } = world();
    await gateway.submit(approve(obligation));
    const [first, second] = ledger.events();

    ledger.db.query("DELETE FROM events WHERE seq = ?").run(first!.seq);

    expect(ledger.verifyChain()).toEqual({ ok: false, brokenAt: second!.seq });
  });

  it("never records the approval MAC or secret", async () => {
    const { gateway, obligation, ledger } = world();
    const approval = approve(obligation);
    await gateway.submit(approval);

    const dump = JSON.stringify(ledger.events());

    expect(dump).not.toContain(approval.mac);
  });
});
