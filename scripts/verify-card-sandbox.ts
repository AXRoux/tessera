/**
 * `bun run scripts/verify-card-sandbox.ts`: pays one supplier invoice by Visa card against the REAL Airwallex sandbox
 * (keys from .env), end to end, with the same code the hosts run. A throwaway ledger file is used, so no existing ledger
 * is touched. Sandbox money only: one $25 transfer (failed and cancelled on purpose) and one $25 card charge.
 *
 *   transfer fails, money back -> agent asks for the invoice card -> a person signs (Airwallex issues it) -> a transfer is
 *   refused while the card holds -> agent pays through Visa TAP -> charge clears and is proved -> certificate v4
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolbox } from "../src/agent/toolbox";
import { issueApproval, newNonce } from "../src/approval/approval";
import { seedIncident } from "../src/demo/scenario";
import { buildRuntime, resolveBeneficiary } from "../src/server/runtime";

const env: Record<string, string | undefined> = { ...process.env, TESSERA_DB: join(mkdtempSync(join(tmpdir(), "tessera-verify-")), "verify.db"), TESSERA_PAID_HOLD_MS: "0", ANTHROPIC_API_KEY: "", TESSERA_OFFLINE: "" };
if (!(env.AWX_BASE_URL ?? "https://api.sandbox.airwallex.com").includes("sandbox")) throw new Error("refusing: this check runs against the Airwallex sandbox only");
const runtime = buildRuntime(env);
const { ledger, gateway, commander, closer, cards, api, model, simulator } = runtime;
const OPERATOR = env.TESSERA_OPERATOR || "operator:verify@tessera";

let failures = 0;
const check = (ok: boolean, what: string, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${what}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};
const stop = (why: string): never => {
  console.log(`\nSTOPPED: ${why}`);
  process.exit(1);
};

console.log(`Airwallex sandbox, ledger ${env.TESSERA_DB}`);
check(commander !== undefined && cards.issuingConnected && cards.canCharge, "card rail on: Issuing connected, TAP merchant available");
const beneficiaryId = await resolveBeneficiary(api, env);
const reference = `VERIFY-CARD-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

// 1. A supplier transfer that failed and came back.
const seeded = await seedIncident({ ledger, gateway, commander, simulator: simulator! }, "card", { reference, beneficiaryId, amountMinor: 2_500, currency: "USD", method: "LOCAL" });
const id = seeded.id;
check(ledger.latestAttempt(id)?.state === "DEAD", `${reference}: transfer failed and Airwallex cancelled it, money back`, ledger.latestAttempt(id)?.awxStatus ?? "");
const first = await commander.assess(id);
check(first.decision.allowed.includes("PAY_BY_CARD"), "PAY_BY_CARD allowed where a replacement is", first.decision.allowed.join(", "));

// 2. The agent asks for the card.
const toolbox = createToolbox({ ledger, gateway, commander, closer, model, cards, actor: "agent:verify", acceptClientText: false });
const asked = await toolbox.call("pay_invoice_by_card", { incidentId: id, reason: "Verification: the supplier's transfer was returned; pay by card." });
check(asked.ok, "agent asked for the invoice card", asked.ok ? "" : asked.message);
const pending = ledger.invoiceCard(id) ?? stop("no card was recorded");
check(pending.state === "PENDING" && pending.amountMinor === 2_500 && pending.category === "supplier", "card PENDING, terms from the invoice", `${pending.merchant}, $25.00, MCCs ${pending.mccs.join("/")}`);

// 3. A person signs; Airwallex issues it with the invoice's terms as its controls.
const signed = await cards.approve(pending.id, OPERATOR, "Verification run: supplier confirmed, pay this invoice by card.");
check(signed.state === "ACTIVE", "Airwallex issued the card with the supplier categories", signed.state === "ACTIVE" ? `card ${signed.awxCardId} ending ${signed.last4}` : `${signed.state}: ${signed.lastError ?? ""}`);
if (signed.state !== "ACTIVE") stop(`Airwallex did not issue the card: ${signed.lastError ?? signed.state}`);

// 4. No transfer while the card holds: even a person's signed approval is refused by the database.
const previous = ledger.latestAttempt(id)!;
const approval = issueApproval(
  {
    obligationId: id, amountMinor: 2_500, currency: "USD", beneficiaryId: previous.beneficiaryId, method: "LOCAL", reason: previous.reason, replacesAttemptId: previous.id,
    evidenceHash: "a".repeat(64), mode: "HUMAN", approver: OPERATOR, note: "verification: this must be refused", expiresAt: new Date(Date.now() + 60_000).toISOString(), nonce: newNonce(),
  },
  runtime.approvalSecret,
);
const refused = await gateway.submit(approval).then(() => "accepted", (e: Error) => e.name);
check(refused === "DuplicateLockError", "a second transfer is refused while the card holds", refused);

// 5. The agent pays the supplier's checkout through Visa TAP.
const paid = await toolbox.call("pay_invoice_by_card", { incidentId: id, reason: "Verification: the card is signed; pay the supplier." });
const result = paid.ok ? (paid.result as { outcome: string; checkout: { status: string; tapVerified: boolean; orderId: string | null; reason?: string } }) : null;
check(result?.outcome === "PAID" && result.checkout.tapVerified, "paid through Visa TAP, merchant verified the signature", paid.ok ? `${result?.checkout.status} ${result?.checkout.orderId ?? result?.checkout.reason ?? ""}` : paid.message);

// 6. Airwallex reports the charge; Tessera proves it against the signed terms.
for (let i = 0; i < 20 && ledger.cardSettlements(pending.id).length === 0; i++) {
  await cards.sync();
  if (ledger.cardSettlements(pending.id).length === 0) await Bun.sleep(3_000);
}
const card = ledger.requireCard(pending.id);
const proof = ledger.cardSettlements(pending.id).at(-1);
check(card.spentMinor === 2_500 && card.state === "SPENT", "Airwallex cleared exactly $25.00 and the single-use card is spent", `${card.state}, spent ${card.spentMinor}`);
check(proof?.matches === true, "charge proved against every signed term", proof ? proof.checks.map((c) => `${c.check}:${c.ok ? "ok" : c.detail}`).join(" ") : "no proof yet");
check(ledger.requireObligation(id).status === "PAID", "invoice PAID by card");
const again = await toolbox.call("pay_invoice_by_card", { incidentId: id, reason: "Verification: try to pay a second time." });
check(!again.ok, "a second card payment is refused");

// 7. Certified, with the card and the cancelled transfer.
let closed = false;
let blockers: string[] = [];
for (let i = 0; i < 20 && !closed; i++) {
  const outcome = await toolbox.call("reconcile_and_close", { incidentId: id });
  closed = outcome.ok;
  if (!outcome.ok) {
    blockers = ((outcome as { details?: { blockers?: string[] } }).details?.blockers) ?? [outcome.message];
    await Bun.sleep(6_000);
  }
}
check(closed, "reconciled against Airwallex and certified", closed ? "" : blockers.join("; "));
if (closed) {
  const body = JSON.parse(ledger.getCertificateJson(id)!).body;
  check(body.version === 4 && body.card?.tap?.verified === true && body.settledTransferId === null, "certificate v4 carries the card and its TAP checkout", `paid ${body.totals.paidMinor}, fees ${body.totals.feesMinor}`);
}
check(ledger.verifyChain().ok, "hash chain verifies");

console.log(failures === 0 ? `\nSANDBOX CARD CHECK PASSED (${reference})` : `\nSANDBOX CARD CHECK FAILED: ${failures} check(s) (${reference})`);
process.exit(failures === 0 ? 0 : 1);
