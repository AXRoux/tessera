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
      { file: "src/ledger/ledger.ts", find: "payerPaysMinor INTEGER,\n  approvalNonce TEXT NOT NULL UNIQUE,", replace: "payerPaysMinor INTEGER,\n  approvalNonce TEXT NOT NULL," },
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
    edits: [{ file: "src/commander/policy.ts", find: "const withinLimit = limit !== undefined && latest.amountMinor <= limit;", replace: "const withinLimit = limit !== undefined || true;" }],
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
    edits: [{ file: "src/commander/commander.ts", find: "} catch {\n      return null;", replace: "} catch {\n      return { USD: Number.MAX_SAFE_INTEGER, EUR: Number.MAX_SAFE_INTEGER, GBP: Number.MAX_SAFE_INTEGER };" }],
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
    edits: [{ file: "src/commander/commander.ts", find: "if (assessment.evidenceHash !== input.evidenceHash) {\n      throw new ApprovalRejected(\"stale_evidence\", \"the incident changed since the approver reviewed it; review the current assessment and approve again\");\n    }\n    const previous", replace: "if (false) {\n      throw new ApprovalRejected(\"stale_evidence\", \"\");\n    }\n    const previous" }],
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
    edits: [{ file: "src/ledger/ledger.ts", find: "if (mismatch) return { ok: false, brokenAt: null, reason: `attempt", replace: "if (false) return { ok: false, brokenAt: null, reason: `attempt" }],
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
    edits: [{ file: "src/ledger/ledger.ts", find: "COALESCE(?, lastError), updatedAt = ? WHERE id = ? AND state = 'INTENT'", replace: "COALESCE(?, lastError), updatedAt = ? WHERE id = ?" }],
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
  // ---- funding a replacement (conversions) ------------------------------------------------------------------------------
  {
    id: "fund-tool-not-strict",
    describe: "Let fund_replacement accept (and silently drop) an amount, a currency or a rate in its input",
    edits: [{ file: "src/agent/toolbox.ts", find: "schema: z.strictObject({ incidentId: IncidentId }),", replace: "schema: z.object({ incidentId: IncidentId })," }],
    expect: { attacks: [31], tests: [T("toolbox.test.ts", "funds a short wallet from the incident id alone")] },
  },
  {
    id: "fund-db-lock",
    describe: "Drop the database's one-conversion-per-replacement index",
    edits: [{ file: "src/ledger/ledger.ts", find: "ON conversions (forAttemptId) WHERE state IN ('INTENT','BOOKED','SETTLED');", replace: "ON conversions (forAttemptId) WHERE state IN ('NEVER');" }],
    expect: { attacks: [32], tests: [T("funding.test.ts", "refuses a second conversion for the same replacement")] },
  },
  {
    id: "fund-lock-all-layers",
    describe: "Drop the executor's funding-lock check AND the database index, so two processes can each convert",
    edits: [
      { file: "src/ledger/ledger.ts", find: "ON conversions (forAttemptId) WHERE state IN ('INTENT','BOOKED','SETTLED');", replace: "ON conversions (forAttemptId) WHERE state IN ('NEVER');" },
      { file: "src/funding/executor.ts", find: "if (this.ledger.conversionsFor(obligation.id).some((c) => c.forAttemptId === latest.id && holdsFundingLock(c.state))) {", replace: "if (this.ledger.conversionsFor(obligation.id).some((c) => c.forAttemptId === latest.id && holdsFundingLock(c.state)) && (false as boolean)) {" },
    ],
    expect: { attacks: [32, 33] },
  },
  {
    id: "fund-nonce-replay",
    describe: "Stop refusing a spent funding approval nonce",
    edits: [{ file: "src/funding/executor.ts", find: "if (this.ledger.fundingNonceUsed(p.nonce)) throw", replace: "if (false) throw" }],
    expect: { attacks: [34], tests: [T("funding.test.ts", "rejects a changed amount, a payout-domain MAC")] },
  },
  {
    id: "fund-mac-domain",
    describe: "Sign funding approvals without their own MAC domain (so a payout-style signature verifies)",
    edits: [{ file: "src/funding/approval.ts", find: "update(`tessera-funding-v1|${canonicalJson(payload)}`)", replace: "update(canonicalJson(payload))" }],
    expect: { attacks: [34], tests: [T("funding.test.ts", "rejects a changed amount, a payout-domain MAC")] },
  },
  {
    id: "fund-fingerprint-unchecked",
    describe: "Accept a person's funding approval whatever fingerprint it echoes back",
    edits: [{ file: "src/commander/commander.ts", find: "if (recomputed !== quoted.fingerprint || input.fingerprint !== quoted.fingerprint) {", replace: "if (recomputed !== quoted.fingerprint) {" }],
    expect: { tests: [T("funding.test.ts", "refuses a fingerprint that is not the one shown")] },
  },
  {
    id: "fund-quote-age",
    describe: "Book a quote however long ago it was fetched (until Airwallex's own expiry)",
    edits: [{ file: "src/commander/commander.ts", find: "if (now - Date.parse(quote.validFrom) > this.policy.maxQuoteAgeMs) return", replace: "if (false) return" }],
    expect: { attacks: [35], tests: [T("funding.test.ts", "refuses a reviewed quote older than the policy")] },
  },
  {
    id: "fund-rate-drift",
    describe: "Book a quote whose rate drifted past maxRateDriftBps from the plan",
    edits: [{ file: "src/commander/commander.ts", find: "if (quote.sellMinor > ceiling) {", replace: "if (false) {" }],
    expect: { tests: [T("funding.test.ts", "throws away a quote whose rate drifted")] },
  },
  {
    id: "fund-plan-ignores-source-floor",
    describe: "Plan a conversion from a wallet that would end below its own reserve floor",
    edits: [{ file: "src/commander/policy.ts", find: "ok: sellMinor !== null && availableMinor - sellMinor >= floorMinor", replace: "ok: sellMinor !== null" }],
    // The quote check and the executor still refuse to book it (attack 36 holds); the plan itself must not propose it.
    expect: { tests: [T("funding-policy.test.ts", "sells the first source in policy order")] },
  },
  {
    id: "fund-executor-source-floor",
    describe: "Book a conversion that takes the source wallet below its reserve floor",
    edits: [{ file: "src/funding/executor.ts", find: "if (sourceAvailable - p.sellMinor < sourceFloor) {", replace: "if (false) {" }],
    expect: { attacks: [36], tests: [T("funding.test.ts", "refuses once the wallet no longer needs it")] },
  },
  {
    id: "fund-overbuy",
    describe: "Book a conversion that buys more than the shortfall",
    edits: [{ file: "src/funding/executor.ts", find: "if (p.buyMinor > need.buyMinor) refuse(", replace: "if (false) refuse(" }],
    expect: { attacks: [37], tests: [T("funding.test.ts", "refuses to buy more, or less, than the shortfall")] },
  },
  {
    id: "fund-no-auto-limit",
    describe: "Drop the automatic conversion limit",
    edits: [{ file: "src/commander/policy.ts", find: "limit !== undefined && need.buyMinor <= limit;", replace: "limit !== undefined;" }],
    expect: { tests: [T("funding-policy.test.ts", "books on its own up to the automatic conversion limit")] },
  },
  {
    id: "fund-auto-ignores-plan",
    describe: "Book automatically a conversion the plan says needs a person",
    edits: [{ file: "src/commander/commander.ts", find: "if (!plan.autoApprovable) throw", replace: "if (false) throw" }],
    expect: { tests: [T("funding.test.ts", "asks a person above the automatic conversion limit")] },
  },
  {
    id: "fund-when-replace-refused",
    describe: "Allow FUND even where the replacement itself is refused (escalated, bank-detail change, statement credit)",
    edits: [{ file: "src/commander/policy.ts", find: `if (candidates.includes("FUND") && blocked.some((b) => b.action === "REPLACE" && b !== fundFirst)) {`, replace: "if (false) {" }],
    expect: { tests: [T("funding-policy.test.ts", "refuses FUND when the incident is with a person")] },
  },
  {
    id: "fund-escalated-converts",
    describe: "Convert for an escalated incident",
    edits: [{ file: "src/funding/executor.ts", find: `if (obligation.status === "ESCALATED") throw new ObligationNotPayable(obligation.id, \`escalated (`, replace: `if (obligation.status === "ESCALATED" && (false as boolean)) throw new ObligationNotPayable(obligation.id, \`escalated (` }],
    expect: { tests: [T("funding.test.ts", "converts nothing for an escalated incident")] },
  },
  {
    id: "fund-balances-fail-open",
    describe: "Treat unreadable balances as full wallets just before booking",
    edits: [{ file: "src/funding/executor.ts", find: "} catch {\n      return null;", replace: "} catch {\n      return { USD: Number.MAX_SAFE_INTEGER, EUR: 0, GBP: Number.MAX_SAFE_INTEGER };" }],
    expect: { tests: [T("funding.test.ts", "refuses when the balances cannot be read")] },
  },
  {
    id: "fund-quote-reuse",
    describe: "Book a quote more than once (the sandbox reports quotes as MULTI_USE)",
    edits: [{ file: "src/funding/executor.ts", find: "if (this.ledger.quoteUsed(p.quoteId)) refuse(", replace: "if (false) refuse(" }],
    expect: { tests: [T("funding.test.ts", "books a quote once")] },
  },
  {
    id: "fund-recover-skips-lookup",
    describe: "Resolve a conversion left in INTENT by sending again instead of looking its request_id up first",
    edits: [{ file: "src/funding/executor.ts", find: `if (found) return this.settled("ADOPTED_AFTER_AMBIGUITY", this.adopt(row, this.checked(row, found), "recover_lookup"));`, replace: "" }],
    expect: { attacks: [38], tests: [T("funding.test.ts", "survives being killed between the intent")] },
  },
  {
    id: "fund-reused-request-id-unrecognised",
    describe: "Stop recognising the sandbox's 'request_id used in the past' answer as a conversion that already exists",
    edits: [{ file: "src/funding/executor.ts", find: `DuplicateBodySchema.safeParse(error.body).data?.source === "request_id"`, replace: "false" }],
    expect: { tests: [T("funding.test.ts", "adopts the conversion Airwallex already holds")] },
  },
  {
    id: "fund-expired-intent-kept",
    describe: "Never release an intent whose quote expired with nothing at Airwallex",
    edits: [{ file: "src/funding/executor.ts", find: "if (now > expiresAt + this.graceMs) return", replace: "if (false) return" }],
    expect: { tests: [T("funding.test.ts", "releases an intent by itself once its quote expired")] },
  },
  {
    id: "fund-adopt-mismatch",
    describe: "Adopt whatever Airwallex holds under our request_id, whatever its terms",
    edits: [{ file: "src/funding/executor.ts", find: "if (matches) return conversion;", replace: "if (matches || true) return conversion;" }],
    expect: { tests: [T("funding.test.ts", "escalates, and adopts nothing")] },
  },
  {
    id: "fund-book-on-broken-chain",
    describe: "Book a conversion on a ledger that does not verify",
    edits: [{ file: "src/funding/executor.ts", find: "if (!chain.ok) throw new ObligationNotPayable(p.obligationId, `ledger does not verify", replace: "if (!chain.ok && (false as boolean)) throw new ObligationNotPayable(p.obligationId, `ledger does not verify" }],
    expect: { attacks: [39], tests: [T("ledger-verify.test.ts", "catches a settled conversion row deleted")] },
  },
  {
    id: "chain-conversion-row-missing",
    describe: "Stop noticing a conversion row deleted from the conversions table",
    edits: [{ file: "src/ledger/ledger.ts", find: "if (!conversionIds.has(id)) return", replace: "if (false) return" }],
    expect: { attacks: [39], tests: [T("ledger-verify.test.ts", "catches a settled conversion row deleted")] },
  },
  {
    id: "chain-conversion-terms",
    describe: "Stop comparing a conversion row with the FUNDING_INTENT that created it",
    edits: [{ file: "src/ledger/ledger.ts", find: "if (mismatch) return { ok: false, brokenAt: null, reason: `conversion", replace: "if (false) return { ok: false, brokenAt: null, reason: `conversion" }],
    expect: { tests: [T("ledger-verify.test.ts", "catches a conversion's sell amount edited")] },
  },
  {
    id: "closer-skips-conversions",
    describe: "Certify a funded invoice without reconciling its conversions",
    edits: [{ file: "src/closer/closer.ts", find: "for (const row of conversions) funding.push(await this.reconcileFunding(row));", replace: "" }],
    expect: { attacks: [40], tests: [T("funding.test.ts", "certifies version 3")] },
  },
  {
    id: "closer-conversion-in-flight",
    describe: "Stop naming a conversion that has not settled as a reason not to certify",
    edits: [{ file: "src/closer/closer.ts", find: `if (row.state === "INTENT" || row.state === "BOOKED") return`, replace: "if (false) return" }],
    expect: { tests: [T("funding.test.ts", "refuses to certify while the conversion has not settled")] },
  },
  // ---- webhooks -----------------------------------------------------------------------------------------------------------
  {
    id: "webhook-signature",
    describe: "Skip the webhook signature check",
    edits: [{ file: "src/airwallex/webhook.ts", find: "if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {", replace: "if (false) {" }],
    expect: { attacks: [25, 41], tests: [T("airwallex.test.ts", "rejects a body that does not match its signature")] },
  },
  {
    id: "webhook-window",
    describe: "Skip the five-minute timestamp window on a webhook",
    edits: [{ file: "src/airwallex/webhook.ts", find: "if (skew > (input.toleranceMs ?? DEFAULT_TOLERANCE_MS)) {", replace: "if (false) {" }],
    expect: { attacks: [25, 42], tests: [T("airwallex.test.ts", "rejects a correctly signed delivery replayed more than five minutes later")] },
  },
  {
    id: "webhook-first-seen",
    describe: "Report every webhook event id as new",
    edits: [{ file: "src/ledger/ledger.ts", find: "if (result.changes === 0) return false;", replace: "" }],
    expect: { attacks: [25], tests: [T("ledger.test.ts", "webhook")] },
  },
  {
    id: "webhook-dedupe-route",
    describe: "Stop deduplicating redelivered webhooks: the route's seen-check and the ledger's first-seen answer",
    edits: [
      { file: "src/server/webhook.ts", find: "if (ledger.webhookEventSeen(event.id)) return json({ ok: true, duplicate: true });", replace: "" },
      { file: "src/ledger/ledger.ts", find: "if (result.changes === 0) return false;", replace: "" },
    ],
    expect: { attacks: [42], tests: [T("webhook.test.ts", "re-reads the transfer on the first delivery and ignores a redelivery")] },
  },
  {
    id: "webhook-swallows-failed-sync",
    describe: "Mark a webhook handled even when its sync failed",
    edits: [
      {
        file: "src/server/webhook.ts",
        find: `return json({ error: "SyncFailed", message: "the transfer could not be re-read; redeliver this event" }, 503);`,
        replace: "/* swallowed */",
      },
    ],
    expect: { tests: [T("webhook.test.ts", "15. a failed sync is not swallowed by the dedupe")] },
  },
  {
    id: "listener-path",
    describe: "Let the public webhook listener route any path to the handler",
    edits: [{ file: "src/server/webhook-listener.ts", find: `if (path !== WEBHOOK_PATH) return refuse(404, "NotFound");`, replace: "" }],
    expect: { attacks: [47], tests: [T("webhook.test.ts", "serves exactly one route")] },
  },
  {
    id: "listener-method",
    describe: "Let the public webhook listener take any method on the webhook path",
    edits: [{ file: "src/server/webhook-listener.ts", find: `if (request.method !== "POST") return refuse(405, "MethodNotAllowed", { allow: "POST" });`, replace: "" }],
    expect: { attacks: [47], tests: [T("webhook.test.ts", "serves exactly one route")] },
  },
  {
    id: "listener-source-allowlist",
    describe: "Ignore TESSERA_WEBHOOK_SOURCE_IPS on the public listener",
    edits: [{ file: "src/server/webhook-listener.ts", find: `if (options.allowedSources && !options.allowedSources.has(request.headers.get("cf-connecting-ip") ?? "")) return refuse(403, "Forbidden");`, replace: "" }],
    expect: { tests: [T("webhook.test.ts", "with a source allowlist")] },
  },
  {
    id: "webhook-receipts-unchained",
    describe: "Stop checking the webhook dedupe table against the chain in verifyChain",
    edits: [{ file: "src/ledger/ledger.ts", find: "if (webhooks) return { ok: false, brokenAt: null, reason: webhooks };", replace: "" }],
    expect: { attacks: [48], tests: [T("webhook.test.ts", "chains every taken delivery")] },
  },
  {
    id: "reactions-unreplayed",
    describe: "Stop replaying reactions and wakes in verifyChain",
    edits: [{ file: "src/ledger/ledger.ts", find: "if (reactions) return { ok: false, brokenAt: null, reason: reactions };", replace: "" }],
    expect: { attacks: [49], tests: [T("webhook.test.ts", "verifyChain refuses a reaction")] },
  },
  {
    id: "reaction-twice",
    describe: "React to a bank change again when a reaction already covers it (the pending filter and the in-transaction recheck)",
    edits: [
      { file: "src/server/reactions.ts", find: "reacted.has(event.seq) || ", replace: "" },
      { file: "src/server/reactions.ts", find: "if (changes.some((c) => covered.has(c.statusSeq))) return null;", replace: "" },
    ],
    expect: { tests: [T("webhook.test.ts", "the sweep and a webhook behave the same")] },
  },
  {
    id: "reaction-own-actions",
    describe: "Treat Tessera's own transfers (created, not moved by the bank) as bank news",
    edits: [{ file: "src/server/reactions.ts", find: "if (!p.success || p.data.from === null || !Object.hasOwn(REACTABLE_VIA, p.data.via)) continue;", replace: "if (!p.success) continue;" }],
    expect: { tests: [T("webhook.test.ts", "the scripted agent is woken and replaces the payment")] },
  },
  {
    id: "wake-any-reaction",
    describe: "Wake an agent for every reaction, not only when the decision changed into something an agent can act on",
    edits: [{ file: "src/server/reactions.ts", find: "const actionable = decisionChanged && !Object.hasOwn(QUIET, after.recommended)", replace: "const actionable = true || decisionChanged && !Object.hasOwn(QUIET, after.recommended)" }],
    expect: { tests: [T("webhook.test.ts", "wakes one run scoped to the incident")] },
  },
  {
    id: "wake-unscoped",
    describe: "Give the woken agent a toolbox that is not scoped to its incident",
    edits: [{ file: "src/server/wake.ts", find: "actor: agent.actor, acceptClientText: false, scope,", replace: "actor: agent.actor, acceptClientText: false," }],
    expect: { tests: [T("webhook.test.ts", "wakes one run scoped to the incident")] },
  },
  {
    id: "wake-single-flight",
    describe: "Start a fresh wake for every request instead of joining the incident's open or running one",
    edits: [{ file: "src/server/wake.ts", find: "if (slot) {", replace: "if (slot && (false as boolean)) {" }],
    expect: { tests: [T("webhook.test.ts", "single flight per incident")] },
  },
  {
    id: "wake-cap-incident",
    describe: "Drop the per-incident cap on event-driven runs",
    edits: [{ file: "src/server/wake.ts", find: "if (used.incident >= this.limits.perIncident) {", replace: "if (false as boolean) {" }],
    expect: { tests: [T("webhook.test.ts", "caps runs per incident")] },
  },
  {
    id: "wake-cap-global",
    describe: "Drop the overall cap on event-driven runs",
    edits: [{ file: "src/server/wake.ts", find: "if (used.all >= this.limits.global) {", replace: "if (false as boolean) {" }],
    expect: { attacks: [46], tests: [T("webhook.test.ts", "caps runs across all incidents")] },
  },
  {
    id: "wake-ignores-gate",
    describe: "Start an event-driven run while another agent run holds the ledger",
    edits: [{ file: "src/server/wake.ts", find: "while (!gate.tryAcquire()) {", replace: "while (false as boolean) {" }],
    expect: { tests: [T("webhook.test.ts", "shares the one-run-at-a-time gate")] },
  },
  {
    id: "wake-in-public-demo",
    describe: "Let TESSERA_AGENT_ON_EVENT turn event-driven runs on in a public demo",
    edits: [{ file: "src/server/runtime.ts", find: "    agentOnEvent = false;\n", replace: "" }],
    expect: { tests: [T("webhook.test.ts", "never on in a public demo")] },
  },
  {
    id: "seed-emits-events",
    describe: "Deliver simulated webhooks while the offline demo seeds its history",
    edits: [{ file: "src/airwallex/fake-webhooks.ts", find: "if (!this.route || this.quiet > 0) return;", replace: "if (!this.route) return;" }],
    expect: { tests: [T("webhook.test.ts", "seeding the demo delivers nothing")] },
  },
  {
    id: "wake-brief-reference-only",
    describe: "Brief a scoped agent run with the incident's reference only, not the incidentId its tools take",
    edits: [{ file: "src/server/agent-runs.ts", find: "Work incident ${incident.reference} (incidentId ${incident.id}) only.", replace: "Work incident ${incident.reference} only." }],
    expect: { tests: [T("webhook.test.ts", "the brief names the incidentId the tools take")] },
  },
  {
    id: "public-demo-spends-model",
    describe: "Let a public demo use the configured model (any provider) instead of the scripted agent",
    edits: [{ file: "src/server/runtime.ts", find: "  if (!publicDemo) {\n    try {\n      configured = modelFromEnv(env);", replace: "  if (true as boolean) {\n    try {\n      configured = modelFromEnv(env);" }],
    expect: { tests: [T("demo.test.ts", "never lets a public demo spend a model key")] },
  },
  {
    id: "openai-extract-unvalidated",
    describe: "Accept an OpenAI-compatible model's extraction without checking it against the schema",
    edits: [{ file: "src/commander/openai.ts", find: "    const result = request.schema.safeParse(call.input);\n    if (!result.success) throw new ModelError(`model output failed validation: ${result.error.message}`, null);\n    return result.data;", replace: "    return call.input as T;" }],
    expect: { tests: [T("openai.test.ts", "accepts only a call to the offered tool whose arguments pass the schema")] },
  },
  {
    id: "openai-extract-any-call",
    describe: "Take whatever tool an OpenAI-compatible model called as the extraction, not only the one offered",
    edits: [{ file: "src/commander/openai.ts", find: "const call = turn.calls.find((c) => c.name === request.toolName);", replace: "const call = turn.calls[0];" }],
    expect: { tests: [T("openai.test.ts", "accepts only a call to the offered tool whose arguments pass the schema")] },
  },
];
