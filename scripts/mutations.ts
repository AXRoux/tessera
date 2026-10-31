/**
 * The catalog for `bun run mutate`: each entry removes ONE guard and names the attack(s) and test(s) that exist to notice.
 *
 * Rules for an entry:
 *  - `find` occurs exactly once in `file` (the tool refuses a stale catalog and says which anchor drifted).
 *  - The edit removes a real guard but leaves the code compiling: a mutation that does not typecheck, or that makes the
 *    red team unable to load, is reported INVALID, because it proves nothing about the guard.
 *  - `expect` lists what MUST fail. It is what the guard is for, decided from the design, not copied from what happened
 *    to break; the tool also prints attacks that broke without being expected, so a shared guard is visible.
 */
import type { Mutation } from "./mutate-lib";

const T = (file: string, name?: string) => ({ file: `tests/${file}`, ...(name ? { name } : {}) });

export const MUTATIONS: Mutation[] = [
  // ---- approvals ----------------------------------------------------------------------------------------------
  {
    id: "hmac-check",
    describe: "Skip the HMAC check on an approval",
    edits: [{ file: "src/approval/approval.ts", find: "if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {", replace: "if (false) {" }],
    // Attack 6 (edit the amount after approval) is also stopped by the gateway's own amount check, so it is not aimed here.
    expect: { attacks: [5], tests: [T("approval.test.ts")] },
  },
  {
    id: "amount-bound-twice",
    describe: "Stop checking an approval's signature AND its amount against the invoice (so an edited amount can be paid)",
    edits: [
      { file: "src/approval/approval.ts", find: "if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {", replace: "if (false) {" },
      { file: "src/gateway/gateway.ts", find: "if (p.amountMinor !== obligation.amountMinor || p.currency !== obligation.currency) {", replace: "if ((p.amountMinor !== obligation.amountMinor || p.currency !== obligation.currency) && (false as boolean)) {" },
    ],
    expect: { attacks: [6] },
  },
  {
    id: "approval-expiry",
    describe: "Accept an approval after it expired",
    edits: [{ file: "src/approval/approval.ts", find: "if (Date.parse(parsed.data.expiresAt) <= now.getTime()) {", replace: "if (Date.parse(parsed.data.expiresAt) <= now.getTime() && (false as boolean)) {" }],
    expect: { attacks: [8], tests: [T("approval.test.ts")] },
  },
  {
    id: "approval-replay",
    describe: "Stop refusing a spent approval nonce (the database's unique nonce column is a second guard)",
    edits: [
      {
        file: "src/gateway/gateway.ts",
        find: `if (this.ledger.nonceUsed(p.nonce)) throw new ApprovalRejected("replayed", "approval nonce already used");`,
        replace: "",
      },
    ],
    expect: { tests: [T("gateway.test.ts", "rejects an approval that has already been spent")] },
  },
  {
    id: "replay-all-layers",
    describe: "Remove EVERY defence against spending an approval twice: the nonce check, the unique nonce column, the open-attempt lock and the replaces-the-latest-attempt binding",
    edits: [
      { file: "src/gateway/gateway.ts", find: `if (this.ledger.nonceUsed(p.nonce)) throw new ApprovalRejected("replayed", "approval nonce already used");`, replace: "" },
      { file: "src/ledger/ledger.ts", find: "approvalNonce TEXT NOT NULL UNIQUE,", replace: "approvalNonce TEXT NOT NULL," },
      { file: "src/gateway/gateway.ts", find: `if (latest && (latest.state === "INTENT" || latest.state === "LIVE" || latest.state === "PAID")) {`, replace: `if (latest && (latest.state === "INTENT" || latest.state === "LIVE" || latest.state === "PAID") && (false as boolean)) {` },
      { file: "src/gateway/gateway.ts", find: "if ((latest?.id ?? null) !== p.replacesAttemptId) {", replace: "if ((latest?.id ?? null) !== p.replacesAttemptId && (false as boolean)) {" },
      { file: "src/ledger/ledger.ts", find: "ON attempts (obligationId) WHERE state IN ('INTENT','LIVE','PAID');", replace: "ON attempts (obligationId) WHERE state IN ('NEVER');" },
    ],
    // Attack 1 (two payouts at once) is also held by the replaces-the-latest-attempt binding, so it is aimed here, not at the lock alone.
    expect: { attacks: [1, 4] },
  },
  {
    id: "first-attempt-terms",
    describe: "Let a first payment use terms other than the invoice's own",
    edits: [{ file: "src/gateway/gateway.ts", find: "if (termsChanged && !personCorrects) {", replace: "if (false) {" }],
    expect: { attacks: [7], tests: [T("money-path.test.ts", "a first attempt, with nothing behind it")] },
  },

  // ---- the lock -----------------------------------------------------------------------------------------------
  {
    id: "no-open-attempt-lock",
    describe: "Remove the one-open-attempt index and the gateway's check",
    edits: [
      { file: "src/ledger/ledger.ts", find: "ON attempts (obligationId) WHERE state IN ('INTENT','LIVE','PAID');", replace: "ON attempts (obligationId) WHERE state IN ('NEVER');" },
      {
        file: "src/gateway/gateway.ts",
        find: `if (latest && (latest.state === "INTENT" || latest.state === "LIVE" || latest.state === "PAID")) {`,
        replace: `if (latest && (latest.state === "INTENT" || latest.state === "LIVE" || latest.state === "PAID") && (false as boolean)) {`,
      },
    ],
    expect: { attacks: [2, 3], tests: [T("gateway.test.ts", "is enforced by the database even when the gateway is bypassed")] },
  },
  {
    id: "escalated-begin-guard",
    describe: "Let a policy approval pay an escalated invoice",
    edits: [{ file: "src/gateway/gateway.ts", find: `if (obligation.status === "ESCALATED" && p.mode !== "HUMAN") {`, replace: `if (obligation.status === "ESCALATED" && p.mode !== "HUMAN" && (false as boolean)) {` }],
    expect: { attacks: [16] },
  },
  {
    id: "abandoned-resets-playbook",
    describe: "Judge a replacement by the latest attempt even when it was abandoned",
    edits: [{ file: "src/gateway/gateway.ts", find: `const settled = attempts.findLast((a) => a.state !== "ABANDONED") ?? null;`, replace: "const settled = attempts.at(-1) ?? null;" }],
    expect: { attacks: [26], tests: [T("money-path.test.ts", "11. a person may correct the terms")] },
  },
  {
    id: "no-verify-before-pay",
    describe: "Remove the ledger-verifies check before a payment",
    edits: [{ file: "src/gateway/gateway.ts", find: "this.requireVerifiedLedger(p.obligationId);", replace: "" }],
    expect: { attacks: [27], tests: [T("gateway.test.ts", "refuses to pay on a ledger whose attempt row was edited")] },
  },

  // ---- the playbook and the policy ---------------------------------------------------------------------------------
  {
    id: "unknown-code-auto",
    describe: "Make a failure code nobody has seen auto-replaceable",
    edits: [{ file: "src/domain/playbook.ts", find: 'class: "UNKNOWN",\n  replace: "FORBIDDEN",', replace: 'class: "UNKNOWN",\n  replace: "AUTO",' }],
    expect: { attacks: [11], tests: [T("playbook.test.ts")] },
  },
  {
    id: "duplicate-auto",
    describe: "Make DUPLICATION_RETURN auto-replaceable",
    edits: [{ file: "src/domain/playbook.ts", find: 'row("91301", "DUPLICATION_RETURN", "POSSIBLE_DUPLICATE", "FORBIDDEN"),', replace: 'row("91301", "DUPLICATION_RETURN", "POSSIBLE_DUPLICATE", "AUTO"),' }],
    expect: { attacks: [9, 12], tests: [T("playbook.test.ts")] },
  },
  {
    id: "no-amount-limit",
    describe: "Drop the automatic replacement amount limit",
    edits: [{ file: "src/commander/policy.ts", find: "} else if (limit !== undefined && latest.amountMinor <= limit) {", replace: "} else if (true) {" }],
    expect: { attacks: [10], tests: [T("policy.test.ts")] },
  },
  {
    id: "no-replacement-cap",
    describe: "Drop the cap on automatic replacements per invoice",
    edits: [{ file: "src/commander/policy.ts", find: "if (facts.automaticReplacements >= policy.maxAutoReplacements) {", replace: "if (false) {" }],
    expect: { attacks: [29], tests: [T("policy.test.ts", "escalates once the automatic replacement budget is spent")] },
  },
  {
    id: "unknown-balance-auto",
    describe: "Treat an unreadable wallet balance as enough money",
    edits: [{ file: "src/commander/commander.ts", find: "walletAvailableMinor: balance === null ? null :", replace: "walletAvailableMinor: balance === null ? Number.MAX_SAFE_INTEGER :" }],
    // The policy's own test builds a null balance by hand; this one makes the balance read FAIL, which is where fail-open would come from.
    expect: { tests: [T("commander.test.ts", "refuses when the wallet balance cannot be read")] },
  },
  {
    id: "credit-lifts-claim",
    describe: "Let any record's statement credit lift an open non-receipt claim",
    edits: [{ file: "src/commander/policy.ts", find: `const creditConfirmsReceipt = statementShowsCredit && evidence?.creditSource === "manual";`, replace: "const creditConfirmsReceipt = statementShowsCredit;" }],
    expect: { tests: [T("commander.test.ts", "13. a later record's statement credit cannot lift a non-receipt claim")] },
  },

  // ---- evidence and the quarantined reader ----------------------------------------------------------------------------
  {
    id: "evidence-newest-only",
    describe: "Make effectiveEvidence return only the newest record",
    edits: [{ file: "src/commander/evidence.ts", find: "const all = base ? [base, ...later] : later;", replace: "const all = (base ? [base, ...later] : later).slice(-1);" }],
    expect: { attacks: [22], tests: [T("evidence.test.ts"), T("commander.test.ts", "evidence cannot be laundered")] },
  },
  {
    id: "no-crosscheck",
    describe: "Disable the code's bank-detail cross-check of what the reader said",
    edits: [{ file: "src/commander/evidence.ts", find: "if (!requestsDetailChange && DETAIL_CHANGE.test(text)) {", replace: "if (false) {" }],
    expect: { attacks: [13], tests: [T("evidence.test.ts")] },
  },
  {
    id: "echo-email",
    describe: "Return the reader's free-text summary to the agent",
    edits: [{ file: "src/agent/toolbox.ts", find: "codeAdjustments: evidence.adjustments,\n  };", replace: "codeAdjustments: evidence.adjustments,\n    summary: evidence.summary,\n  };" }],
    expect: { attacks: [14], tests: [T("toolbox.test.ts", "never puts the text of a supplier message")] },
  },

  // ---- what the agent is told and may do -----------------------------------------------------------------------------
  // The agent's escalation reason is withheld in TWO places: `escalationView` for the incident list, and `scrub` over every
  // result. The scrub alone covers the list too, so removing `escalationView` alone changes nothing an agent can see (a
  // redundant layer, deliberately). `scrub-off` below is the load-bearing one: it also leaks through policy reasons and refusals.
  {
    id: "scrub-off",
    describe: "Stop scrubbing a withheld escalation reason out of policy reasons and refusals",
    edits: [{ file: "src/agent/toolbox.ts", find: "return swaps.length === 0 ? outcome : (replaceStrings(outcome, swaps) as ToolOutcome);", replace: "return outcome;" }],
    expect: { attacks: [28], tests: [T("toolbox.test.ts", "never lets an agent-written escalation reason reach another agent")] },
  },
  {
    id: "raw-sender",
    describe: "Show a sender's raw address to the agent",
    edits: [{ file: "src/agent/toolbox.ts", find: "id: sha256Hex(senderAddress(messages[index]!.from)).slice(0, 12),", replace: "id: messages[index]!.from," }],
    expect: { attacks: [28], tests: [T("toolbox.test.ts", "never shows any part of a sender's address")] },
  },
  {
    id: "no-draft-guard",
    describe: "Turn the supplier-reply guard off",
    edits: [{ file: "src/commander/drafts.ts", find: "for (const rule of RULES) if (rule.test(text)) return rule.reason;", replace: "" }],
    expect: { attacks: [17], tests: [T("drafts.test.ts")] },
  },
  {
    id: "draft-ignores-commander",
    describe: "Let a draft ignore what the Commander allows",
    edits: [{ file: "src/agent/toolbox.ts", find: "if (!a.decision.allowed.includes(needed)) {", replace: "if (false) {" }],
    expect: { attacks: [18], tests: [T("drafts.test.ts")] },
  },
  {
    id: "close-without-commander",
    describe: "Let the toolbox and the operator close without the Commander's say",
    edits: [{ file: "src/commander/commander.ts", find: `if (decision.allowed.includes("CLOSE")) return;`, replace: "if (true) return;" }],
    expect: { attacks: [30], tests: [T("api.test.ts", "refuses an operator's close while the supplier is disputing receipt")] },
  },
  {
    id: "skip-evidence-hash-compare",
    describe: "Skip the evidenceHash comparison on a human approval",
    edits: [{ file: "src/commander/commander.ts", find: "if (assessment.evidenceHash !== input.evidenceHash) {", replace: "if (false) {" }],
    expect: { attacks: [23], tests: [T("commander.test.ts", "rejects an approval of an assessment that has since changed")] },
  },
  {
    id: "hash-unbound-to-incident",
    describe: "Leave the incident's id out of the evidence hash",
    edits: [{ file: "src/commander/commander.ts", find: "obligation: { id: obligation.id, amountMinor:", replace: "obligation: { amountMinor:" }],
    expect: { tests: [T("commander.test.ts", "12. the evidence hash is bound to the incident and the proposal")] },
  },

  // ---- the closer ------------------------------------------------------------------------------------------------------
  {
    id: "hold-window",
    describe: "Ignore the PAID hold window",
    edits: [{ file: "src/closer/closer.ts", find: "if (heldMs < this.paidHoldMs) {", replace: "if (false) {" }],
    expect: { tests: [T("closer.test.ts", "inside the hold window after PAID")] },
  },
  {
    id: "hold-window-both",
    describe: "Ignore the PAID hold window in BOTH places that enforce it: the Commander's CLOSE decision and the Closer",
    edits: [
      { file: "src/closer/closer.ts", find: "if (heldMs < this.paidHoldMs) {", replace: "if (heldMs < this.paidHoldMs && (false as boolean)) {" },
      { file: "src/commander/policy.ts", find: "if (facts.paidObservedAt && heldMs >= policy.paidHoldMs) {", replace: "if (facts.paidObservedAt) {" },
    ],
    expect: { attacks: [19], tests: [T("closer.test.ts", "inside the hold window after PAID"), T("policy.test.ts")] },
  },
  {
    id: "closer-no-resync",
    describe: "Certify without re-reading the transfer from Airwallex first",
    edits: [{ file: "src/closer/closer.ts", find: "await this.gateway.sync(obligationId);", replace: "" }],
    expect: { tests: [T("closer.test.ts", "when Airwallex now says FAILED though the ledger last saw PAID")] },
  },
  {
    id: "closer-no-resync-both",
    describe: "Certify without re-reading the transfer from Airwallex, in BOTH places that do (the Closer and the Commander's assessment)",
    edits: [
      { file: "src/closer/closer.ts", find: "await this.gateway.sync(obligationId);", replace: "" },
      { file: "src/commander/commander.ts", find: "await this.gateway.sync(obligationId);", replace: "" },
    ],
    expect: { attacks: [20], tests: [T("closer.test.ts", "when Airwallex now says FAILED though the ledger last saw PAID")] },
  },
  {
    id: "no-revoke-on-late-failure",
    describe: "Keep a certificate standing after the bank returns the payment",
    edits: [{ file: "src/gateway/gateway.ts", find: "if (this.ledger.getCertificateJson(current.obligationId)) {", replace: "if (false) {" }],
    expect: { attacks: [24], tests: [T("closer.test.ts", "revokes the certificate and escalates")] },
  },

  // ---- the hash chain --------------------------------------------------------------------------------------------------
  {
    id: "chain-hash-unchecked",
    describe: "Stop verifying each event's hash",
    edits: [{ file: "src/ledger/ledger.ts", find: "if (row.hash !== expected) return", replace: "if (false) return" }],
    expect: { attacks: [21], tests: [T("ledger.test.ts", "detects an edited event payload")] },
  },
  {
    id: "chain-head-ignored",
    describe: "Ignore the stored chain head (deleted newest events go unnoticed)",
    edits: [
      { file: "src/ledger/ledger.ts", find: "if (head !== null && head.count !== rows.length) {", replace: "if (head !== null && head.count !== rows.length && (false as boolean)) {" },
      { file: "src/ledger/ledger.ts", find: "if (head !== null && head.hash !== prev) return", replace: "if (head !== null && head.hash !== prev && (false as boolean)) return" },
    ],
    expect: { attacks: [27], tests: [T("ledger.test.ts", "detects events deleted from the end")] },
  },
  {
    id: "chain-missing-attempt",
    describe: "Stop noticing an attempt row that was deleted",
    edits: [{ file: "src/ledger/ledger.ts", find: "if (!attemptIds.has(id)) return", replace: "if (false) return" }],
    expect: { tests: [T("ledger-verify.test.ts", "3. a deleted attempt row is detected")] },
  },
  {
    id: "chain-terms-unchecked",
    describe: "Stop comparing an attempt's terms and amounts with the event that created it",
    edits: [{ file: "src/ledger/ledger.ts", find: "if (mismatch) return", replace: "if (false) return" }],
    expect: { tests: [T("ledger-verify.test.ts", "4. attempt and obligation columns are verified against their events")] },
  },
  {
    id: "verify-no-snapshot",
    describe: "Read the chain without one consistent snapshot",
    edits: [{ file: "src/ledger/ledger.ts", find: "return this.db.transaction(() => this.verifySnapshot()).deferred();", replace: "return this.verifySnapshot();" }],
    expect: { tests: [T("ledger-verify.test.ts", "6. verifyChain reads one consistent snapshot")] },
  },

  // ---- the independent review's fixes -------------------------------------------------------------------------------------
  {
    id: "send-without-reread",
    describe: "Send without re-reading the attempt first (a released attempt may still be sending)",
    edits: [{ file: "src/gateway/gateway.ts", find: `if (current.state !== "INTENT") throw new SendRefused("not_intent", current);`, replace: "" }],
    expect: { tests: [T("money-path.test.ts", "1. a released INTENT never leaves a live sender")] },
  },
  {
    id: "send-for-escalated",
    describe: "Send a left-behind payment for an invoice that has been escalated",
    edits: [{ file: "src/gateway/gateway.ts", find: `if (this.ledger.requireObligation(current.obligationId).status === "ESCALATED") throw new SendRefused("escalated", current);`, replace: "" }],
    expect: { tests: [T("money-path.test.ts", "5. an escalated obligation is never sent for")] },
  },
  {
    id: "intent-release-floor",
    describe: "Release a young INTENT that Airwallex has no transfer for yet",
    edits: [{ file: "src/gateway/gateway.ts", find: "if (ageMs >= this.minIntentReleaseAgeMs) return;", replace: "if (true) return;" }],
    expect: { tests: [T("money-path.test.ts", "(b) refuses to release a young INTENT")] },
  },
  {
    id: "release-approval-states",
    describe: "Release a transfer that is only waiting in an approval queue",
    edits: [{ file: "src/gateway/gateway.ts", find: `if (transfer.status !== "CANCELLED") {`, replace: `if (transfer.status !== "CANCELLED" && !NEVER_EXECUTED_STATUSES.includes(transfer.status)) {` }],
    expect: { tests: [T("money-path.test.ts", "2. approval states are resumable")] },
  },
  {
    id: "equal-second-rollback",
    describe: "Let a same-second snapshot that is earlier in the status order roll a status back",
    edits: [{ file: "src/gateway/gateway.ts", find: "return incoming !== undefined && applied !== undefined && incoming < applied;", replace: "return false;" }],
    expect: { tests: [T("money-path.test.ts", "9. whole-second updated_at cannot roll a PAID back")] },
  },
  {
    id: "abandon-not-cas",
    describe: "Abandon an attempt without checking it is still an INTENT",
    edits: [{ file: "src/ledger/ledger.ts", find: "WHERE id = ? AND state = 'INTENT'", replace: "WHERE id = ?" }],
    expect: { tests: [T("money-path.test.ts", "10. abandon is a compare-and-set")] },
  },
  {
    id: "no-rate-limit-backoff",
    describe: "Resend straight away when Airwallex says Retry-After: 0",
    edits: [
      {
        file: "src/gateway/gateway.ts",
        find: "await this.sleep(Math.min(Math.max(error.retryAfterMs ?? 1_000 * 2 ** retry, backoff), MAX_RATE_LIMIT_WAIT_MS));",
        replace: "await this.sleep(Math.min(error.retryAfterMs ?? 1_000 * 2 ** retry, MAX_RATE_LIMIT_WAIT_MS));",
      },
    ],
    expect: { tests: [T("money-path.test.ts", "16. the 429 loop")] },
  },

  {
    id: "mints-new-request-id",
    describe: "Send each create with a fresh request_id instead of the one recorded in the ledger (a naive retry)",
    edits: [{ file: "src/gateway/gateway.ts", find: "request_id: attempt.requestId,", replace: "request_id: crypto.randomUUID()," }],
    expect: { attacks: [15], tests: [T("gateway.test.ts", "adopts the transfer by request_id when the create response is lost")] },
  },
  // ---- webhooks -----------------------------------------------------------------------------------------------------------
  {
    id: "webhook-signature",
    describe: "Skip the webhook signature check",
    edits: [{ file: "src/airwallex/webhook.ts", find: "if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {", replace: "if (false) {" }],
    expect: { attacks: [25], tests: [T("airwallex.test.ts", "rejects a body that does not match its signature")] },
  },
  {
    id: "webhook-window",
    describe: "Skip the five-minute timestamp window on a webhook",
    edits: [{ file: "src/airwallex/webhook.ts", find: "if (skew > (input.toleranceMs ?? DEFAULT_TOLERANCE_MS)) {", replace: "if (false) {" }],
    expect: { attacks: [25], tests: [T("airwallex.test.ts", "rejects a correctly signed delivery replayed more than five minutes later")] },
  },
  {
    id: "webhook-first-seen",
    describe: "Report every webhook event id as new",
    edits: [
      {
        file: "src/ledger/ledger.ts",
        find: ".run(event.id, event.name, event.transferId, event.createdAt, this.now().toISOString());\n    return result.changes > 0;",
        replace: ".run(event.id, event.name, event.transferId, event.createdAt, this.now().toISOString());\n    return true;",
      },
    ],
    expect: { attacks: [25], tests: [T("ledger.test.ts", "webhook")] },
  },
  {
    id: "webhook-dedupe-route",
    describe: "Stop deduplicating redelivered webhooks in the API route",
    edits: [{ file: "src/server/api.ts", find: "if (ledger.webhookEventSeen(event.id)) return json({ ok: true, duplicate: true });", replace: "" }],
    expect: { tests: [T("api.test.ts", "re-reads the transfer on the first delivery and ignores a redelivery")] },
  },
  {
    id: "webhook-swallows-failed-sync",
    describe: "Mark a webhook handled even when its sync failed",
    edits: [
      {
        file: "src/server/api.ts",
        find: `return json({ error: "SyncFailed", message: "the transfer could not be re-read; redeliver this event" }, 503);`,
        replace: "/* swallowed */",
      },
    ],
    expect: { tests: [T("api.test.ts", "15. a failed sync is not swallowed by the dedupe")] },
  },
];
