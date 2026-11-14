import { describe, expect, it } from "bun:test";
import { fitToSchema, type SchemaAnswer } from "../src/airwallex/beneficiary-schema";
import { AirwallexClient, usBeneficiaryRequest } from "../src/airwallex/client";
import { SPIKE_SUPPLIER } from "../src/airwallex/types";

const P = "create_beneficiary_request.";
const leaf = (required = true) => ({ relevant: true, required, type: "string" });

/** The US LOCAL schema as a sandbox business answered it on 2026-11-14 (trimmed): bank_name required, the category irrelevant. */
const US_ANSWER: SchemaAnswer = {
  errors: { [`${P}beneficiary.bank_details.bank_account_category`]: { code: "IRRELEVANT_VALUE", value: "Checking" } },
  schema: {
    [`${P}beneficiary`]: { relevant: true, required: true, type: "object" },
    [`${P}beneficiary.address.city`]: leaf(),
    [`${P}beneficiary.address.state`]: leaf(),
    [`${P}beneficiary.bank_details.account_number`]: leaf(),
    [`${P}beneficiary.bank_details.account_routing_type1`]: leaf(),
    [`${P}beneficiary.bank_details.bank_name`]: leaf(),
    [`${P}beneficiary.bank_details.local_clearing_system`]: leaf(false),
    [`${P}beneficiary.company_name`]: leaf(),
    [`${P}payment_methods`]: { relevant: true, required: true, type: "array" },
    [`${P}payment_methods.item`]: { type: "string" },
  },
};

function client(answer: SchemaAnswer | Response) {
  const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/authentication/login")) return Response.json({ token: "t", expires_at: "2099-01-01T00:00:00+0000" }, { status: 201 });
    sent.push({ path, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    if (path.endsWith("/beneficiaries/schema")) return answer instanceof Response ? answer : Response.json(answer);
    return Response.json({ id: "ben_1", beneficiary: {} }, { status: 201 });
  }) as typeof fetch;
  return { sent, api: new AirwallexClient({ baseUrl: "https://api.sandbox.example", clientId: "c", apiKey: "k", fetch: fakeFetch, minIntervalMs: 0, sleep: async () => {} }) };
}

describe("fitting a beneficiary to Airwallex's schema", () => {
  it("drops what the account calls irrelevant, reads payment_methods as transfer_methods, and finds nothing missing", () => {
    const fit = fitToSchema(usBeneficiaryRequest(SPIKE_SUPPLIER), US_ANSWER);
    expect(fit.problems).toEqual([]);
    expect(fit.dropped).toEqual(["beneficiary.bank_details.bank_account_category"]);
    expect(fit.request).toMatchObject({ transfer_methods: ["LOCAL"], beneficiary: { bank_details: { bank_name: "JPMorgan Chase Bank" } } });
    expect((fit.request as { beneficiary: { bank_details: Record<string, unknown> } }).beneficiary.bank_details).not.toHaveProperty("bank_account_category");
  });

  it("names a missing required field and a value that fails validation, in Airwallex's words", () => {
    const request = usBeneficiaryRequest({ ...SPIKE_SUPPLIER, bankName: "" });
    const answer: SchemaAnswer = {
      ...US_ANSWER,
      errors: { [`${P}beneficiary.bank_details.account_routing_type1`]: { code: "FAILED_VALIDATION_FUNCTIONS", value: "ABA", validation_functions: [{ description: "Should equal aba" }] } },
    };
    expect(fitToSchema(request, answer).problems).toEqual(["beneficiary.bank_details.account_routing_type1: Should equal aba", "beneficiary.bank_details.bank_name is required"]);
  });
});

describe("the US supplier payee Tessera creates on connect", () => {
  it("asks the account's schema first, then creates with the fitted request", async () => {
    const { api, sent } = client(US_ANSWER);
    expect(await api.createBeneficiary(SPIKE_SUPPLIER)).toEqual({ id: "ben_1", nickname: SPIKE_SUPPLIER.nickname });
    expect(sent.map((s) => s.path)).toEqual(["/api/v1/beneficiaries/schema", "/api/v1/beneficiaries/create"]);
    expect(sent[0]!.body).toEqual({ create_beneficiary_request: usBeneficiaryRequest(SPIKE_SUPPLIER) });
    expect(sent[1]!.body).toMatchObject({
      nickname: SPIKE_SUPPLIER.nickname,
      transfer_methods: ["LOCAL"],
      beneficiary: { bank_details: { local_clearing_system: "ACH", account_routing_type1: "aba", bank_name: "JPMorgan Chase Bank" } },
    });
    expect((sent[1]!.body as { beneficiary: { bank_details: Record<string, unknown> } }).beneficiary.bank_details).not.toHaveProperty("bank_account_category");
  });

  it("keeps the account category where the account requires it", async () => {
    const { api, sent } = client({ errors: {}, schema: { ...US_ANSWER.schema, [`${P}beneficiary.bank_details.bank_account_category`]: leaf() } });
    await api.createBeneficiary(SPIKE_SUPPLIER);
    expect(sent[1]!.body).toMatchObject({ beneficiary: { bank_details: { bank_account_category: "Checking" } } });
  });

  it("refuses before creating anything when the schema says the request cannot pass", async () => {
    const { api, sent } = client({ errors: {}, schema: { ...US_ANSWER.schema, [`${P}beneficiary.bank_details.swift_code`]: leaf() } });
    await expect(api.createBeneficiary(SPIKE_SUPPLIER)).rejects.toThrow("beneficiary.bank_details.swift_code is required");
    expect(sent.map((s) => s.path)).toEqual(["/api/v1/beneficiaries/schema"]);
  });

  it("still creates when the beta schema endpoint cannot answer: the create validates on its own", async () => {
    const { api, sent } = client(Response.json({ code: "internal_error", message: "boom" }, { status: 500 }));
    expect(await api.createBeneficiary(SPIKE_SUPPLIER)).toEqual({ id: "ben_1", nickname: SPIKE_SUPPLIER.nickname });
    expect(sent.map((s) => s.path)).toEqual(["/api/v1/beneficiaries/schema", "/api/v1/beneficiaries/create"]);
  });
});
