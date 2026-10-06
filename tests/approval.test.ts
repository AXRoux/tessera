import { describe, expect, it } from "bun:test";
import { ApprovalRejected } from "../src/errors";
import { PayoutGateway } from "../src/gateway/gateway";
import { approve, SECRET, world } from "./helpers/world";

describe("approval binding", () => {
  it("rejects an approval whose amount was edited after signing", async () => {
    const { obligation, gateway, api } = world();
    const signed = approve(obligation);
    const tampered = { ...signed, payload: { ...signed.payload, amountMinor: 1_000_000 } };

    await expect(gateway.submit(tampered)).rejects.toMatchObject({ name: "ApprovalRejected", reason: "bad_signature" });
    expect(api.all).toHaveLength(0);
  });

  it("rejects an approval whose beneficiary was swapped after signing", async () => {
    const { obligation, gateway } = world();
    const signed = approve(obligation);
    const tampered = { ...signed, payload: { ...signed.payload, beneficiaryId: "attacker" } };

    await expect(gateway.submit(tampered)).rejects.toMatchObject({ reason: "bad_signature" });
  });

  it("rejects an approval signed with another secret", async () => {
    const { obligation, ledger, api } = world();
    const stranger = new PayoutGateway({ ledger, api, approvalSecret: "a-different-secret-a-different-secret" });

    await expect(stranger.submit(approve(obligation))).rejects.toBeInstanceOf(ApprovalRejected);
  });

  it("rejects an expired approval", async () => {
    const { obligation, gateway } = world();
    const expired = approve(obligation, { expiresAt: new Date(Date.now() - 1_000).toISOString() });

    await expect(gateway.submit(expired)).rejects.toMatchObject({ reason: "expired" });
  });

  it("refuses to start with a weak signing secret", () => {
    const { ledger, api } = world();

    expect(() => new PayoutGateway({ ledger, api, approvalSecret: SECRET.slice(0, 8) })).toThrow();
  });
});
