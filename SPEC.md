# Spec: Tessera

Exactly-once payout gateway, exception handling (the kit's "Incident Commander") and independent reconciliation, on the Airwallex sandbox.
Hackathon: Airwallex Agentic Banking Hackathon, starter kit 3 (Payment Ops Incident Commander).

## Objective

A supplier says a transfer never arrived. An agent decides wait, replace, or escalate. Code guarantees the
obligation is never paid twice, whatever the agent, a retry, a crash, or a late bank return does.

Success criteria (all demonstrated against the real sandbox):

1. At most one open payout attempt per obligation, enforced by the database, not by the agent.
2. Killing the process mid-create (`kill -9`) and restarting never creates a second transfer.
3. A replacement is only issued after the original is provably `CANCELLED` (funds returned), never at `FAILED`.
4. Every Airwallex failure code the sandbox can emit maps to a playbook entry; unknown codes fail closed.
5. `PAID` is not final: a later `FAILED` reopens the obligation and is recorded as a late failure.
6. Every approval is bound to obligation, amount, currency, beneficiary, method, reason and evidence hash, is single-use, and expires.
7. The Closer refuses to close until per-transfer ledger entries reconcile (slice 2).

## Verified sandbox facts (do not re-derive)

- Auth: `x-client-id` + `x-api-key` -> 30 min bearer token.
- Transfer states: `SCHEDULED|PROCESSING -> SENT -> PAID -> FAILED -> CANCELLED`; `PAID` can still fail (simulator allows it). `FAILED` flips to `CANCELLED` within seconds and refunds amount minus fee.
- Failure info is nested: `failure: { code, message, details }`. `failure.code` is a lossless key (32 types -> 32 codes, `fixtures/failure-codes.json`). `details.type` is useless (always `INCORRECT_ROUTING`). Docs' failure table disagrees with the sandbox for several codes.
- Fees differ from the guide: LOCAL USD costs 3, SWIFT EUR costs 13.33. Always read `fee_amount`; never hardcode.
- Duplicate `request_id` -> `400 duplicate_request_id` with `details.id` = existing transfer id, even if the payload differs.
- `GET /transfers?request_id=` returns `{items: []}` when unknown. `GET /transfers/{id}` unknown -> `404 not_found`.
- Validation errors -> `400 validation_failed`. Sandbox wallets start with 10,000,000 USD/EUR/GBP/CNY.
- `GET /financial_transactions?source_id=<transfer id>` returns `PAYOUT` and `PAYOUT_REVERSAL` rows (used by the Closer).

## Tech stack

Core (repo root): Bun 1.4, TypeScript (tsc 7), `bun:sqlite`, `zod` 4, `bun test`.
Web (`web/`): Next.js 16 (App Router, Turbopack), React 19, Tailwind 4, Zen Dots + Archivo + JetBrains Mono via `next/font`.
The web app never holds a credential beyond the operator token; it parses every API response with `src/server/wire.ts`.

## Commands

```
bun test                 # unit + integration tests (in-memory SQLite, fake Airwallex)
bun run typecheck        # tsc --noEmit (core)
bun run smoke            # real sandbox: pay, fail, deny replacement, human-approved replacement, certify
bun run chaos            # real sandbox: kill -9 mid-create, recover, assert one transfer
bun run commander        # real sandbox: wait / auto-replace / escalate decided by policy
bun run evidence:live    # real Claude reads four supplier messages
bun run api              # Tessera API on 127.0.0.1:4010
cd web && bun run dev    # Next.js on 127.0.0.1:3100   (bun run build && bun run start for production)
```

## Structure

```
src/money.ts             minor-unit conversion
src/canonical.ts         canonical JSON + sha256
src/errors.ts            domain errors
src/airwallex/           zod schemas, PayoutApi interface, REST client
src/domain/playbook.ts   failure code -> class -> replacement policy
src/ledger/ledger.ts     SQLite obligations/attempts/events/certificates, one-open-attempt index, hash chain
src/approval/approval.ts HMAC approvals
src/gateway/gateway.ts   exactly-once submit / recover / sync
src/closer/              reconciliation, certificate schemas (pure) and signing
src/commander/           decision policy, evidence reader, Anthropic transport, approvals
src/server/              HTTP API (api.ts), process entry (main.ts), wire contract (wire.ts, pure zod)
web/                     Next.js operations console (board, incident page, same-origin proxy)
tests/                   behavior tests + FakePayoutApi
scripts/                 sandbox smoke, chaos, exception-handling demo, live evidence reader
fixtures/                failure-codes.json (captured from the sandbox)
```

## Design rules

- Intent is written to the ledger before the network call. Ambiguous outcomes (timeout, 5xx, 429, lost response)
  are resolved by `GET /transfers?request_id=`, never by a fresh `request_id`. Re-sending the same `request_id` is safe.
- Attempt states: `INTENT -> LIVE -> PAID -> DEAD`, plus `ABANDONED` (provably never created). A partial unique index
  allows one attempt in `INTENT|LIVE|PAID` per obligation. Only `DEAD` (Airwallex `CANCELLED`) or `ABANDONED` release the lock.
- Unknown Airwallex statuses keep the lock (fail closed).
- Replacement policy per failure class: `AUTO`, `AFTER_CHANGE` (objective change required, or a human with a written note), `FORBIDDEN` (human with a written note only).
- Amounts, thresholds, state transitions live in code. The model reads evidence and ranks allowed actions; it never holds credentials.
- Events are append-only and hash-chained; tampering is detectable.

## Boundaries

- Always: sandbox only; keys from env; typed tools; tests for invariants.
- Ask first: new runtime dependencies; anything touching production credentials.
- Never: commit `.env`; hardcode fees; create a transfer with a new `request_id` after an ambiguous outcome.

## Open questions

- An MCP server so Claude can drive the typed tools (needs approval to add `@modelcontextprotocol/sdk`).
- Whether HackerEarth's pre-Oct-25 submission requires a demo, repo, or video (only the user can see the form).
