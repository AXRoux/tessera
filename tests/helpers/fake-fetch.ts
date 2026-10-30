import { AirwallexClient } from "../../src/airwallex/client";
import type { FakePayoutApi } from "../../src/airwallex/fake";

export interface FakeHttp {
  client: AirwallexClient;
  /** Every request the client sent, as "METHOD /path?query". */
  calls: string[];
  /** Responses to serve (after login) before the fake answers, in order: e.g. a 429. */
  queued: Response[];
  /** Every wait the client asked for (pacing is off, so these are retry waits). */
  waits: number[];
}

export const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/**
 * The real AirwallexClient talking HTTP to the in-memory fake: login, transfers (cursor-paged like the real API),
 * one transfer, and wallet lines. Waits are recorded, not slept.
 */
export function fakeHttp(fake: FakePayoutApi): FakeHttp {
  const calls: string[] = [];
  const queued: Response[] = [];
  const waits: number[] = [];
  const handler = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}${url.search}`);
    await Bun.sleep(1); // let concurrent callers overlap, as they do over a network
    if (url.pathname === "/api/v1/authentication/login") return jsonResponse({ token: "token-1" });
    const next = queued.shift();
    if (next) return next;
    if (method === "GET" && url.pathname === "/api/v1/transfers") {
      const from = url.searchParams.get("from_created_at") ?? new Date(0).toISOString();
      return jsonResponse(fake.listTransfersPage(from, url.searchParams.get("page") ?? undefined));
    }
    if (method === "GET" && url.pathname.startsWith("/api/v1/transfers/")) {
      const transfer = fake.transfers.get(decodeURIComponent(url.pathname.slice("/api/v1/transfers/".length)));
      return transfer ? jsonResponse(transfer) : jsonResponse({ code: "not_found", message: "Transfer not found" }, 404);
    }
    if (method === "GET" && url.pathname === "/api/v1/financial_transactions") {
      return jsonResponse({ items: await fake.listFinancialTransactions(url.searchParams.get("source_id") ?? "") });
    }
    return jsonResponse({ code: "not_found", message: `no route ${url.pathname}` }, 404);
  };
  const client = new AirwallexClient({
    baseUrl: "https://api.fake.test",
    clientId: "client",
    apiKey: "key",
    fetch: handler as typeof fetch,
    minIntervalMs: 0,
    sleep: async (ms) => void waits.push(ms),
  });
  return { client, calls, queued, waits };
}
