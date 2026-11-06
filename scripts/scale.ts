/**
 * `bun run scale`: many incidents at once, worked by an agent, then the one property that matters checked for every
 * invoice: at most one live payout, in the ledger and at Airwallex, on a hash chain that verifies.
 *
 *   bun run scale                     offline: 100 incidents on the simulator, the scripted agent (not Claude)
 *   bun run scale -- --n 300          more of them
 *   bun run scale -- --claude         Claude works them instead (needs ANTHROPIC_API_KEY and TESSERA_MODEL)
 *   bun run scale -- --live --n 12    on the Airwallex sandbox, throttled under its 10 requests/second
 *
 * Incidents alternate USD LOCAL and EUR SWIFT and cycle through every playbook outcome the demo knows (wait,
 * transient failure, possible duplicate, details to correct, bank-detail phishing, settled, "nothing arrived").
 * The agent works them in batches of 20, each run scoped to its batch.
 */
import { createToolbox } from "../src/agent/toolbox";
import { COMMANDER_SYSTEM, runAgent } from "../src/agent/loop";
import { checkInvariant } from "../src/demo/invariant";
import { INCIDENT_KINDS, runTag, seedIncident, type SeededIncident } from "../src/demo/scenario";
import { computeMetrics } from "../src/server/metrics";
import { buildRuntime, resolveBeneficiary } from "../src/server/runtime";
import { formatMinor } from "../src/money";

const args = process.argv.slice(2);
const live = args.includes("--live");
const claude = args.includes("--claude");
const nAt = args.indexOf("--n");
const n = nAt >= 0 ? Number(args[nAt + 1]) : live ? 12 : 100;
if (!Number.isSafeInteger(n) || n < 1 || n > 1_000) throw new Error("--n must be a whole number between 1 and 1000");
const HOLD_MS = 6_000;
const BATCH = 20;

/** Spaces every call to Airwallex at least `gapMs` apart, so a sandbox run stays under its rate limit. */
function throttled(gapMs: number) {
  let next = 0;
  const wait = async () => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + gapMs;
    if (at > now) await Bun.sleep(at - now);
  };
  return <T extends object>(target: T): T =>
    new Proxy(target, {
      get(obj, key, receiver) {
        const value = Reflect.get(obj, key, receiver);
        if (typeof value !== "function") return value;
        return async (...callArgs: unknown[]) => {
          await wait();
          return Reflect.apply(value, obj, callArgs);
        };
      },
    });
}

// Offline never inherits keys from .env unless --claude asks for Claude: a scale run must not spend tokens by accident.
const base: Record<string, string | undefined> = live || claude ? { ...process.env } : { TESSERA_APPROVAL_SECRET: process.env.TESSERA_APPROVAL_SECRET };
const env: Record<string, string | undefined> = {
  ...base,
  ...(live ? { TESSERA_DB: ":memory:" } : { TESSERA_OFFLINE: "1" }),
  TESSERA_PAID_HOLD_MS: String(HOLD_MS),
};
const runtime = buildRuntime(env, live ? { wrap: throttled(110) } : {});
const { api, simulator, ledger, gateway, commander, closer, model, agent } = runtime;
if (!simulator) throw new Error("--live needs AWX_BASE_URL pointing at the sandbox");
if (!agent) throw new Error("no agent: --claude needs ANTHROPIC_API_KEY and TESSERA_MODEL");
if (claude && agent.kind !== "claude") throw new Error("--claude needs ANTHROPIC_API_KEY and TESSERA_MODEL");

const beneficiaries = { USD: await resolveBeneficiary(api, env, "USD"), EUR: await resolveBeneficiary(api, env, "EUR") };
const startedAt = new Date(Date.now() - 60_000).toISOString();
const tag = runTag();
console.log(`scale: ${n} incidents ${live ? "on the Airwallex sandbox" : "offline (simulated Airwallex)"}, agent ${agent.kind === "claude" ? "Claude" : "scripted (not Claude)"}`);

const seedStart = performance.now();
const seeded: SeededIncident[] = [];
// No "fund" incidents here: seeding one stages its wallet down to the reserve floor plus one invoice, which would starve
// every later incident paid from that wallet. The funding path has its own incident in the ACME demo and its own tests.
const KINDS = INCIDENT_KINDS.filter((k) => k !== "fund");
for (let i = 0; i < n; i++) {
  const kind = KINDS[i % KINDS.length]!;
  const eur = i % 2 === 1;
  seeded.push(
    await seedIncident({ ledger, gateway, commander, simulator }, kind, {
      reference: `SCALE-${String(i + 1).padStart(4, "0")}-${tag}`,
      beneficiaryId: eur ? beneficiaries.EUR : beneficiaries.USD,
      amountMinor: 1_000 + (i % 9) * 1_250,
      currency: eur ? "EUR" : "USD",
      method: eur ? "SWIFT" : "LOCAL",
    }),
  );
}
const seedMs = performance.now() - seedStart;
console.log(`  seeded in ${(seedMs / 1000).toFixed(1)}s; waiting out the ${HOLD_MS / 1000}s hold window`);
await Bun.sleep(HOLD_MS + 500);

const workStart = performance.now();
let calls = 0;
let refused = 0;
let steps = 0;
for (let i = 0; i < seeded.length; i += BATCH) {
  const batch = seeded.slice(i, i + BATCH);
  const toolbox = createToolbox({
    ledger, gateway, commander, closer, model, actor: agent.actor, acceptClientText: false, scope: new Set(batch.map((s) => s.id)),
  });
  const run = await runAgent({
    model: agent.model, toolbox, system: COMMANDER_SYSTEM, task: "Work every open incident and report.",
    maxSteps: 16 + 3 * batch.length, maxCalls: 10 + 8 * batch.length,
  });
  calls += run.calls.length;
  refused += run.calls.filter((c) => !c.outcome.ok && c.outcome.kind === "refused").length;
  steps += run.steps;
  process.stdout.write(`  batch ${i / BATCH + 1}: ${batch.length} incidents, ${run.calls.length} tool calls, stopped: ${run.stoppedBecause}\n`);
}
const workMs = performance.now() - workStart;

const metrics = computeMetrics(ledger);
const report = await checkInvariant(ledger, api, seeded.map((s) => s.id), startedAt);
const byStatus = new Map<string, number>();
for (const invoice of report.invoices) byStatus.set(invoice.status, (byStatus.get(invoice.status) ?? 0) + 1);
const refusedMoney = Object.entries(metrics.refusedAmountMinor).map(([c, m]) => formatMinor(m, c)).join(" + ") || "none";

console.log(`\nmetrics`);
console.log(`  incidents            ${metrics.incidents} (${[...byStatus].map(([s, c]) => `${c} ${s}`).join(", ")})`);
console.log(`  certified            ${metrics.certified}   median time to certify ${metrics.medianResolutionMs === null ? "n/a" : `${(metrics.medianResolutionMs / 1000).toFixed(1)}s`}`);
console.log(`  auto-replaced        ${metrics.autoReplaced}`);
console.log(`  escalated            ${metrics.escalated}`);
console.log(`  payments refused     ${metrics.paymentsRefused}   money held back ${refusedMoney}`);
console.log(`  agent refusals       ${metrics.agentRefusals} of ${calls} tool calls (${refused} this run), ${steps} model turns`);
console.log(`  time                 seed ${(seedMs / 1000).toFixed(1)}s, agent ${(workMs / 1000).toFixed(1)}s`);
const broken = report.invoices.filter((i) => !i.ok);
for (const invoice of broken) console.log(`  ✗ ${invoice.reference}: ${invoice.openAttempts} open attempts, ${invoice.liveTransfers} live transfers`);
console.log(`  hash chain           ${report.chainOk ? "verifies" : "BROKEN"}`);
console.log(`\n${report.ok ? "INVARIANT HELD" : "INVARIANT BROKEN"}: at most one live payout per invoice across ${report.invoices.length} invoices.`);
ledger.close();
process.exit(report.ok ? 0 : 1);
