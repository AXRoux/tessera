/**
 * `bun run scripts/offline-smoke.ts` (CI): the offline demo end to end, in-process, with no keys and no network.
 * Boots the API handler on the simulator, seeds the eight ACME incidents over HTTP, lets the scripted agent work them
 * through POST /api/agent/run, then asserts each incident landed where the policy says, the metrics add up, at most one
 * live payout exists per invoice, the funded replacement certifies with its conversion, the invoice paid by Visa card
 * (asked for by the agent, signed by a person, paid through Visa TAP) certifies with its card, and the hash chain verifies.
 */
import { checkInvariant } from "../src/demo/invariant";
import { createApi } from "../src/server/api";
import { buildRuntime, resolveBeneficiary } from "../src/server/runtime";
import { SignedCertificateSchema } from "../src/closer/certificate";
import { AgentStreamEventSchema, HealthSchema, IncidentViewSchema, MetricsSchema, SeedResultSchema } from "../src/server/wire";

const HOLD_MS = 1_500;
// Built from scratch, never from process.env: a key in .env must not turn this into a model run.
const runtime = buildRuntime({ TESSERA_OFFLINE: "1", TESSERA_PAID_HOLD_MS: String(HOLD_MS), TESSERA_SWEEP_MS: "0" });
const { api, simulator, ledger, gateway, commander, closer, cards, model, readerName, agent, paidHoldMs, apiToken } = runtime;
const token = apiToken!;
const handle = createApi({
  ledger, gateway, commander, closer, cards, model, readerName, simulator, token, operator: "ops@acme.example",
  beneficiaryId: await resolveBeneficiary(api, {}), eurBeneficiaryId: await resolveBeneficiary(api, {}, "EUR"), paidHoldMs, agent, offline: true,
});

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return handle(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers: { "content-type": "application/json", "x-tessera-token": token },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

const failures: string[] = [];
const expect = (ok: boolean, what: string) => {
  console.log(`  ${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failures.push(what);
};

const health = HealthSchema.parse(await (await call("GET", "/api/health")).json());
expect(health.offline && health.agent?.kind === "scripted" && health.reader === "offline keyword reader", "health: offline, scripted agent, offline reader");

const seed = SeedResultSchema.parse(await (await call("POST", "/api/demo/seed")).json());
expect(seed.seeded.length === 8, "seeded eight ACME incidents");
await Bun.sleep(HOLD_MS + 300);

const agentRun = async (body: Record<string, unknown>) =>
  (await (await call("POST", "/api/agent/run", body)).text())
    .split("\n\n")
    .flatMap((chunk) => chunk.split("\n").filter((line) => line.startsWith("data: ")))
    .map((line) => AgentStreamEventSchema.parse(JSON.parse(line.slice(6))));
const events = await agentRun({});
const done = events.find((e) => e.type === "done");
expect(done?.type === "done" && done.stoppedBecause === "finished", `agent run finished (${done?.type === "done" ? `${done.calls} calls` : "no done event"})`);
const summary = events.filter((e) => e.type === "text").at(-1);
if (summary?.type === "text") console.log(summary.text.split("\n").map((l) => `    ${l}`).join("\n"));

const [wait, transient, duplicate, phish, settled, missing, fund, byCard] = seed.seeded.map((s) => s.id);
const status = (id: string | undefined) => ledger.requireObligation(id!).status;
const view = async (id: string | undefined) => IncidentViewSchema.parse(await (await call("GET", `/api/obligations/${id}`)).json());
expect((await view(wait)).draft?.kind === "STATUS" && status(wait) === "PAYING", "ACME-1041 deferred with a status draft, still paying");
expect(ledger.attemptsFor(transient!).length === 2, "ACME-1042 replaced automatically under a new attempt");
expect(status(duplicate) === "ESCALATED", "ACME-1043 (possible duplicate) escalated");
expect(status(phish) === "ESCALATED", "ACME-1044 (bank-detail change by email) escalated");
expect(status(settled) === "CLOSED", "ACME-1045 certified");
expect((await view(missing)).draft?.kind === "PROOF", "ACME-1046 proof-of-payment draft");
expect((await view(phish)).inbox.every((m) => m.read), "supplier messages marked read");
const conversions = ledger.conversionsFor(fund!);
expect(conversions.length === 1 && conversions[0]!.state === "SETTLED", "ACME-1047 short EUR wallet funded by one settled conversion");
expect(ledger.attemptsFor(fund!).length === 2, "ACME-1047 then replaced on the new balance");

const metrics = MetricsSchema.parse(await (await call("GET", "/api/metrics")).json());
expect(metrics.incidents === 8 && metrics.certified === 1 && metrics.autoReplaced === 2 && metrics.escalated === 2, "metrics match the ledger");

// The funded replacement lands; after the hold the certificate carries both legs of the conversion as booked.
for (const status of ["SENT", "PAID"] as const) expect((await call("POST", `/api/obligations/${fund}/simulate`, { status })).ok, `ACME-1047 replacement ${status}`);
await Bun.sleep(HOLD_MS + 300);
expect((await call("POST", `/api/obligations/${fund}/close`)).ok, "ACME-1047 certified");
const certificate = SignedCertificateSchema.parse(await (await call("GET", `/api/obligations/${fund}/certificate`)).json());
const line = certificate.body.funding?.[0];
expect(
  certificate.body.version === 3 && certificate.body.funding?.length === 1 && line?.conversionId === conversions[0]!.conversionId
    && line?.actual?.buyMinor === line?.expected.buyMinor && line?.actual?.sellMinor === line?.expected.sellMinor,
  "ACME-1047 certificate v3: the conversion's legs as planned and as booked",
);

// The supplier chasing a missed deadline: the agent asked for a single-use card bound to the invoice; a person signs it,
// the agent pays the supplier's checkout through Visa TAP, and after the hold the certificate carries the card.
const requested = (await view(byCard)).invoiceCard;
expect(requested?.state === "PENDING" && requested.byAgent && requested.amountMinor === 2_500 && ledger.attemptsFor(byCard!).length === 1, "ACME-1048 agent asked for a Visa card for the invoice, no second transfer");
expect((await call("POST", `/api/cards/${requested!.id}/approve`, { note: "Supplier confirmed by phone; pay this invoice by card." })).ok, "ACME-1048 card signed by a person");
const cardRun = await agentRun({ incidentId: byCard });
expect(cardRun.some((e) => e.type === "result" && e.tool === "pay_invoice_by_card" && e.ok), "ACME-1048 agent paid the supplier through Visa TAP");
const paidCard = (await view(byCard)).invoiceCard;
expect(paidCard?.state === "SPENT" && paidCard.checkouts.at(-1)?.tapVerified === true && paidCard.settlements[0]?.matches === true, "ACME-1048 card spent once, TAP verified, charge proved against the signed terms");
await Bun.sleep(HOLD_MS + 300);
expect((await call("POST", `/api/obligations/${byCard}/close`)).ok, "ACME-1048 certified");
const cardCertificate = SignedCertificateSchema.parse(await (await call("GET", `/api/obligations/${byCard}/certificate`)).json());
expect(
  cardCertificate.body.version === 4 && cardCertificate.body.card?.cardId === paidCard!.id && cardCertificate.body.settledTransferId === null && cardCertificate.body.totals.paidMinor === 2_500,
  "ACME-1048 certificate v4: paid by card, the failed transfer beside it",
);

const report = await checkInvariant(ledger, api, seed.seeded.map((s) => s.id), new Date(0).toISOString());
expect(report.invoices.every((i) => i.ok), "at most one live payout per invoice");
expect(report.chainOk, "hash chain verifies");

console.log(failures.length === 0 ? "\nOFFLINE SMOKE PASSED" : `\nOFFLINE SMOKE FAILED: ${failures.length} check(s)`);
process.exit(failures.length === 0 ? 0 : 1);
