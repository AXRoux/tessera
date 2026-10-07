import { describe, expect, it } from "bun:test";
import { ATTACKS } from "./redteam/attacks";

describe("red team: every attempt to pay twice, pay the wrong party or rewrite history fails", () => {
  for (const attack of ATTACKS) {
    it(`${attack.title} (${attack.layer})`, async () => {
      const result = await attack.run();
      expect(result.stoppedBy).not.toBe("NOT STOPPED");
      expect(result.held).toBe(true);
    });
  }

  it("covers every layer of the design", () => {
    const layers = new Set(ATTACKS.map((a) => a.layer));
    for (const layer of ["Database", "Approvals", "Playbook", "Policy", "Quarantine", "Gateway", "Closer", "Hash chain"]) {
      expect(layers.has(layer as never)).toBe(true);
    }
  });
});
