/**
 * `bun run scripts/offline-smoke.ts` (CI): the offline demo end to end, in-process, with no keys and no network.
 * Boots the API handler on the simulator, seeds the six ACME incidents over HTTP, lets the scripted agent work them
 * through POST /api/agent/run, then asserts each incident landed where the policy says, the metrics add up, at most one
 * live payout exists per invoice, and the hash chain verifies.
 */
import { checkInvariant } from "../src/demo/invariant";
import { createApi } from "../src/server/api";
import { buildRuntime, resolveBeneficiary } from "../src/server/runtime";
import { AgentStreamEventSchema, HealthSchema, IncidentViewSchema, MetricsSchema, SeedResultSchema } from "../src/server/wire";

const HOLD_MS = 1_500;
// Built from scratch, never from process.env: a key in .env must not turn this into a Claude run.
const runtime = buildRuntime({ TESSERA_OFFLINE: "1", TESSERA_PAID_HOLD_MS: String(HOLD_MS), TESSERA_SWEEP_MS: "0" });
const { api, simulator, ledger, gateway, commander, closer, model, agent, paidHoldMs, apiToken } = runtime;
const token = apiToken!;
const handle = createApi({
  ledger, gateway, commander, closer, model, simulator, token, operator: "ops@acme.example",
  beneficiaryId: await resolveBeneficiary(api, {}), paidHoldMs, agent, offline: true,
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
expect(health.offline && health.agent === "scripted" && health.model, "health: offline, scripted agent, offline reader");

const seed = SeedResultSchema.parse(await (await call("POST", "/api/demo/seed")).json());
expect(seed.seeded.length === 6, "seeded six ACME incidents");
await Bun.sleep(HOLD_MS + 300);

const run = await call("POST", "/api/agent/run", {});
const events = (await run.text())
  .split("\n\n")
  .flatMap((chunk) => chunk.split("\n").filter((line) => line.startsWith("data: ")))
  .map((line) => AgentStreamEventSchema.parse(JSON.parse(line.slice(6))));
const done = events.find((e) => e.type === "done");
expect(done?.type === "done" && done.stoppedBecause === "finished", `agent run finished (${done?.type === "done" ? `${done.calls} calls` : "no done event"})`);
const summary = events.filter((e) => e.type === "text").at(-1);
if (summary?.type === "text") console.log(summary.text.split("\n").map((l) => `    ${l}`).join("\n"));

const [wait, transient, duplicate, phish, settled, missing] = seed.seeded.map((s) => s.id);
const status = (id: string | undefined) => ledger.requireObligation(id!).status;
const view = async (id: string | undefined) => IncidentViewSchema.parse(await (await call("GET", `/api/obligations/${id}`)).json());
expect((await view(wait)).draft?.kind === "STATUS" && status(wait) === "PAYING", "ACME-1041 deferred with a status draft, still paying");
expect(ledger.attemptsFor(transient!).length === 2, "ACME-1042 replaced automatically under a new attempt");
expect(status(duplicate) === "ESCALATED", "ACME-1043 (possible duplicate) escalated");
expect(status(phish) === "ESCALATED", "ACME-1044 (bank-detail change by email) escalated");
expect(status(settled) === "CLOSED", "ACME-1045 certified");
expect((await view(missing)).draft?.kind === "PROOF", "ACME-1046 proof-of-payment draft");
expect((await view(phish)).inbox.every((m) => m.read), "supplier messages marked read");

const metrics = MetricsSchema.parse(await (await call("GET", "/api/metrics")).json());
expect(metrics.incidents === 6 && metrics.certified === 1 && metrics.autoReplaced === 1 && metrics.escalated === 2, "metrics match the ledger");

const report = await checkInvariant(ledger, api, seed.seeded.map((s) => s.id), new Date(0).toISOString());
expect(report.invoices.every((i) => i.ok), "at most one live payout per invoice");
expect(report.chainOk, "hash chain verifies");

console.log(failures.length === 0 ? "\nOFFLINE SMOKE PASSED" : `\nOFFLINE SMOKE FAILED: ${failures.length} check(s)`);
process.exit(failures.length === 0 ? 0 : 1);
