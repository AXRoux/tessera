/**
 * Three incidents against the real sandbox, each decided by the Commander's policy:
 *   1. supplier says "nothing arrived" while the transfer is inside its window        -> WAIT
 *   2. transient bank failure                                                         -> automatic REPLACE
 *   3. DUPLICATION_RETURN (the supplier may already hold the money)                   -> ESCALATE, human-only
 * Supplier evidence is hand-built here; the LLM reader plugs into the same SupplierEvidence shape.
 */
import { AirwallexClient } from "../src/airwallex/client";
import { Commander, type Assessment } from "../src/commander/commander";
import type { SupplierEvidence } from "../src/commander/evidence";
import { AutoReplacementRefused, ReplacementDenied } from "../src/errors";
import { PayoutGateway } from "../src/gateway/gateway";
import { Ledger, type Obligation } from "../src/ledger/ledger";

const secret = process.env.PAYONCE_APPROVAL_SECRET;
if (!secret) throw new Error("PAYONCE_APPROVAL_SECRET is not set");

const client = AirwallexClient.fromEnv();
const ledger = new Ledger(":memory:");
const gateway = new PayoutGateway({ ledger, api: client, approvalSecret: secret });
const commander = new Commander({ ledger, gateway, balances: client, secret });

const beneficiaryId = (await client.listBeneficiaries()).find((b) => b.nickname === "spike-us-supplier")?.id;
if (!beneficiaryId) throw new Error("no spike-us-supplier beneficiary in the sandbox");

const claim: SupplierEvidence = {
  claimsNonReceipt: true, requestsDetailChange: false, referencesObligation: true, statementCredit: null,
  containsEmbeddedInstructions: false, summary: "Supplier: invoice unpaid, deadline passed", adjustments: [],
};

const heading = (title: string) => console.log(`\n=== ${title}`);
const line = (label: string, value: unknown) => console.log(`   ${label.padEnd(20)} ${value}`);

function show(a: Assessment): void {
  const d = a.decision;
  line("recommended", `${d.recommended}  [${d.severity}]`);
  line("allowed", d.allowed.join(", "));
  for (const b of d.blocked) line("blocked", `${b.action}: ${b.reason}`);
  for (const r of d.reasons) line("because", r);
  if (d.recheckAt) line("recheck at", d.recheckAt);
}

async function openObligation(label: string): Promise<Obligation> {
  const obligation = ledger.createObligation({
    reference: `CMD-${label}-${Date.now().toString(36).toUpperCase()}`,
    beneficiaryId: beneficiaryId!,
    amountMinor: 2_500,
    currency: "USD",
    method: "LOCAL",
    reason: "professional_business_services",
  });
  const approval = await commander.humanApproval({ obligationId: obligation.id, approver: "ap@acme.example", note: "scheduled invoice run" });
  const { attempt } = await gateway.submit(approval);
  await client.simulateTransition(attempt.transferId!, "SENT");
  return obligation;
}

async function failWith(obligation: Obligation, failureType: string): Promise<void> {
  const attempt = ledger.latestAttempt(obligation.id)!;
  await client.simulateTransition(attempt.transferId!, "FAILED", failureType);
  for (let i = 0; i < 10; i++) {
    await gateway.sync(obligation.id);
    if (ledger.latestAttempt(obligation.id)!.state === "DEAD") return;
    await Bun.sleep(1_000);
  }
  throw new Error("transfer never reached CANCELLED");
}

heading("1. Supplier says nothing arrived; the transfer is in flight");
const waiting = await openObligation("WAIT");
show(await commander.assess(waiting.id, claim));

heading("2. A transient bank failure (CHANNEL_TIMEOUT)");
const transient = await openObligation("AUTO");
await failWith(transient, "CHANNEL_TIMEOUT");
show(await commander.assess(transient.id));
const replaced = await commander.replaceAutomatically(transient.id);
line("replacement", `${replaced.outcome}, attempt #${replaced.attempt.seq}, new request_id ${replaced.attempt.requestId.slice(0, 8)}`);
await client.simulateTransition(replaced.attempt.transferId!, "SENT");
await client.simulateTransition(replaced.attempt.transferId!, "PAID");
const afterReplace = await commander.assess(transient.id);
line("then", `${afterReplace.decision.recommended}: ${afterReplace.decision.reasons.at(-1)}`);

heading("3. DUPLICATION_RETURN: the supplier may already hold the money");
const risky = await openObligation("DUP");
await failWith(risky, "DUPLICATION_RETURN");
show(await commander.assess(risky.id));
try {
  await commander.replaceAutomatically(risky.id);
  throw new Error("BUG: replaced automatically");
} catch (error) {
  if (!(error instanceof AutoReplacementRefused)) throw error;
  line("automatic replace", "refused");
}
try {
  const vague = await commander.humanApproval({ obligationId: risky.id, approver: "ap@acme.example", note: "ok" });
  await gateway.submit(vague);
  throw new Error("BUG: a one-word note released a possible duplicate");
} catch (error) {
  if (!(error instanceof ReplacementDenied)) throw error;
  line("human, note \"ok\"", "denied: the note must explain why");
}
const real = await commander.humanApproval({
  obligationId: risky.id,
  approver: "cfo@acme.example",
  note: "supplier's bank confirmed no credit received, by callback to the number on file",
});
const released = await gateway.submit(real);
line("human, real note", `${released.outcome}, attempt #${released.attempt.seq}`);
