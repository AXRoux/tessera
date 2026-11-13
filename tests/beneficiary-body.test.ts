import { describe, expect, it } from "bun:test";
import { AirwallexClient } from "../src/airwallex/client";
import { SPIKE_SUPPLIER } from "../src/airwallex/types";

describe("the US supplier payee Tessera creates on connect", () => {
  it("sends the account category Airwallex now requires for US ACH, so a newly created business can connect", async () => {
    const sent: Record<string, unknown>[] = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/authentication/login")) return Response.json({ token: "t", expires_at: "2099-01-01T00:00:00+0000" }, { status: 201 });
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ id: "ben_1", beneficiary: {} }, { status: 201 });
    }) as typeof fetch;
    const client = new AirwallexClient({ baseUrl: "https://api.sandbox.example", clientId: "c", apiKey: "k", fetch: fakeFetch, minIntervalMs: 0, sleep: async () => {} });
    expect(await client.createBeneficiary(SPIKE_SUPPLIER)).toEqual({ id: "ben_1", nickname: SPIKE_SUPPLIER.nickname });
    expect(sent[0]).toMatchObject({
      nickname: SPIKE_SUPPLIER.nickname,
      transfer_methods: ["LOCAL"],
      beneficiary: { bank_details: { local_clearing_system: "ACH", account_routing_type1: "aba", bank_account_category: "Checking" } },
    });
  });
});
