/**
 * Real-sandbox walkthrough of one incident:
 * pay -> SENT -> PAID (lock holds) -> late bank return -> replacement denied by policy -> human-approved replacement
 * -> Closer refuses inside the hold window, then reconciles against Airwallex's wallet lines and certifies.
 * Requires a beneficiary nicknamed "spike-us-supplier" (US/USD/LOCAL) in the sandbox, or SMOKE_BENEFICIARY_ID.
 */
import { AirwallexClient } from "../src/airwallex/client";
import { issueApproval, newNonce, type Approval, type ApprovalPayload } from "../src/approval/approval";
import { verifyCertificate } from "../src/closer/certificate";
import { Closer } from "../src/closer/closer";
import { DuplicateLockError, NotClosable, ReplacementDenied } from "../src/errors";
import { PayoutGateway } from "../src/gateway/gateway";
import { Ledger, type Obligation } from "../src/ledger/ledger";

const secret = process.env.PAYONCE_APPROVAL_SECRET;
if (!secret) throw new Error("PAYONCE_APPROVAL_SECRET is not set");

const client = AirwallexClient.fromEnv();
const ledger = new Ledger(":memory:");
const gateway = new PayoutGateway({ ledger, api: client, approvalSecret: secret });

const beneficiaryId =
  process.env.SMOKE_BENEFICIARY_ID ?? (await client.listBeneficiaries()).find((b) => b.nickname === "spike-us-supplier")?.id;
if (!beneficiaryId) throw new Error("no beneficiary: create one nicknamed spike-us-supplier or set SMOKE_BENEFICIARY_ID");

const obligation = ledger.createObligation({
  reference: `SMK-${Date.now().toString(36).toUpperCase()}`,
  beneficiaryId,
  amountMinor: 1_000,
  currency: "USD",
  method: "LOCAL",
  reason: "professional_business_services",
});

const approve = (replaces: string | null, extra: Partial<ApprovalPayload> = {}): Approval =>
  issueApproval(
    {
      obligationId: obligation.id,
      amountMinor: obligation.amountMinor,
      currency: obligation.currency,
      beneficiaryId: obligation.beneficiaryId,
      method: obligation.method,
      reason: obligation.reason,
      replacesAttemptId: replaces,
      evidenceHash: "0".repeat(64),
      mode: "POLICY",
      approver: "policy:smoke",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      nonce: newNonce(),
      ...extra,
    },
    secret,
  );

const step = (title: string) => console.log(`\n== ${title}`);
const show = (label: string, value: unknown) => console.log(`   ${label.padEnd(26)} ${value}`);
const status = (o: Obligation) => ledger.requireObligation(o.id).status;

async function settle(until: (state: string) => boolean): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const [attempt] = await gateway.sync(obligation.id);
    if (!attempt || until(attempt.state)) return;
    await Bun.sleep(1_000);
  }
  throw new Error("transfer did not settle in time");
}

step("1. Pay the obligation");
const first = await gateway.submit(approve(null));
show("outcome", first.outcome);
show("transfer", first.attempt.transferId);
show("fee (from Airwallex)", `${first.attempt.feeMinor! / 100} USD`);

step("2. SENT, then PAID: PAID is not final, the lock holds");
await client.simulateTransition(first.attempt.transferId!, "SENT");
await client.simulateTransition(first.attempt.transferId!, "PAID");
await settle((s) => s === "PAID");
show("attempt state", ledger.requireAttempt(first.attempt.id).state);
show("obligation status", status(obligation));
try {
  await gateway.submit(approve(first.attempt.id));
  throw new Error("BUG: second payment was allowed while the first is PAID");
} catch (error) {
  if (!(error instanceof DuplicateLockError)) throw error;
  show("second payment", `refused: ${error.message}`);
}

step("3. The beneficiary bank returns the payment after PAID");
await client.simulateTransition(first.attempt.transferId!, "FAILED", "BENEFICIARY_BANK_RETURNED");
await settle((s) => s === "DEAD");
const dead = ledger.requireAttempt(first.attempt.id);
show("attempt state", dead.state);
show("failure", `${dead.failureCode} ${dead.failureMessage}`);
show("obligation status", status(obligation));
show("late failure recorded", ledger.events(obligation.id).some((e) => e.type === "LATE_FAILURE"));

step("4. Policy refuses to replace with the same account");
try {
  await gateway.submit(approve(dead.id));
  throw new Error("BUG: policy replacement was allowed");
} catch (error) {
  if (!(error instanceof ReplacementDenied)) throw error;
  show("replacement", `denied: ${error.message.slice(0, 110)}...`);
}

step("5. A named human vouches in writing; replacement goes out under a new request_id");
const second = await gateway.submit(
  approve(dead.id, { mode: "HUMAN", approver: "ops@acme.example", note: "supplier confirmed account by phone callback" }),
);
show("outcome", second.outcome);
show("request_id differs", second.attempt.requestId !== dead.requestId);
await client.simulateTransition(second.attempt.transferId!, "SENT");
await client.simulateTransition(second.attempt.transferId!, "PAID");
await settle((s) => s === "PAID");
show("replacement state", ledger.requireAttempt(second.attempt.id).state);
show("obligation status", status(obligation));

step("6. Evidence");
const chain = ledger.verifyChain();
show("event chain intact", chain.ok);
show("events recorded", ledger.events(obligation.id).length);
show("attempts", ledger.attemptsFor(obligation.id).map((a) => `#${a.seq}:${a.state}`).join("  "));
const recent = await client.listTransfers(new Date(Date.now() - 30 * 60_000).toISOString());
const transfers = recent.filter((t) => t.reference === obligation.reference);
show("transfers at Airwallex", transfers.map((t) => `${t.id.slice(0, 8)}:${t.status}`).join("  "));

step("7. The Closer: PAID is not final, so the default 24h hold window refuses to close");
try {
  await new Closer({ ledger, api: client, secret }).close(obligation.id);
  throw new Error("BUG: closed inside the hold window");
} catch (error) {
  if (!(error instanceof NotClosable)) throw error;
  for (const blocker of error.blockers) show("blocker", blocker);
}

step("8. Hold shortened for the demo; the Closer reconciles every wallet line and certifies");
const certificate = await new Closer({ ledger, api: client, secret, paidHoldMs: 0 }).close(obligation.id);
const { totals } = certificate.body;
show("supplier received", `${totals.paidMinor / 100} USD (owed ${obligation.amountMinor / 100})`);
show("fees (both attempts)", `${totals.feesMinor / 100} USD`);
show("refunded by failed attempt", `${totals.refundedMinor / 100} USD`);
show("net wallet movement", `${totals.netWalletMinor / 100} USD`);
for (const a of certificate.body.attempts) {
  show(`attempt #${a.seq} ${a.state}`, `expected ${JSON.stringify(a.expected)}  actual ${JSON.stringify(a.actual)}`);
}
show("certificate hash", certificate.hash);
show("signature verifies", verifyCertificate(certificate, secret));
show("obligation status", status(obligation));
