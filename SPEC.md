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
7. The Closer refuses to close until per-transfer ledger entries reconcile.
8. An agent holding only the toolbox cannot pay twice, pay the wrong party, release a forbidden replacement, or make the
   Closer certify early or over a supplier's open claim of non-receipt, however it is prompted. Fifty attacks prove it
   (`bun run redteam`), and `bun run mutate` proves each guard behind them is load-bearing: it removes 94 guards one at a time
   from a private copy and fails unless every one is caught. A live Claude told to pay twice could not (`bun run agent -- --adversary`).
9. Supplier-supplied evidence can only make the system more cautious: tested as a property over every playbook code and over
   sequences of evidence, so a later harmless message cannot erase an earlier warning.
10. A payment is refused when the ledger does not verify (an edited, flipped or deleted row cannot release the lock), and a bank
    return after certification revokes the certificate and reopens the incident.
11. Anyone can run the whole product with no keys: `bun run demo` (simulated Airwallex, scripted agent, labelled as such).
12. A replacement whose wallet cannot cover amount, fee and reserve floor is funded by at most one conversion per replacement,
    buying exactly the shortfall from a wallet that keeps its own floor, booked once under a `request_id` recorded first, and
    certified leg by leg. Shown live on 2026-11-06 (Claude, `ACME-1047`) and under `kill -9` (`bun run chaos convert`).

## Verified sandbox facts (do not re-derive)

- Auth: `x-client-id` + `x-api-key` -> 30 min bearer token.
- Transfer states: `SCHEDULED|PROCESSING -> SENT -> PAID -> FAILED -> CANCELLED`; `PAID` can still fail (simulator allows it). `FAILED` flips to `CANCELLED` within seconds and refunds amount minus fee.
- Failure info is nested: `failure: { code, message, details }`. `failure.code` is a lossless key (32 types -> 32 codes, `fixtures/failure-codes.json`). `details.type` is useless (always `INCORRECT_ROUTING`). Docs' failure table disagrees with the sandbox for several codes.
- Fees differ from the guide: LOCAL USD costs 3, SWIFT EUR costs 13.33 (13.37 on 2026-11-06). Always read `fee_amount`; never hardcode.
- Duplicate `request_id` -> `400 duplicate_request_id` with `details.id` = existing transfer id, even if the payload differs.
- `GET /transfers?request_id=` returns `{items: []}` when unknown. `GET /transfers/{id}` unknown -> `404 not_found`.
- Validation errors -> `400 validation_failed`. Sandbox wallets start with 10,000,000 USD/EUR/GBP/CNY.
- `GET /financial_transactions?source_id=<transfer id>` returns `PAYOUT` and `PAYOUT_REVERSAL` rows (used by the Closer).
- `POST /transfers/create` once answered `400 fee_unknown` ("There is a problem with your transfer fee configuration") for a
  $12 USD `LOCAL` transfer that had worked before (2026-11-06 00:21 UTC); a new invoice for the same supplier 40 s later
  went through. Tessera records it as `ATTEMPT_ABANDONED` (provably not created), so the invoice can be paid again.

### Webhooks (observed 2026-11-03 and 2026-11-06 UTC, subscription `wh_4dc1pXI9eB330dlvEosxioBSxMqKAF6n`, version 2026-08-21)

- Subscriptions are managed over the API with the ordinary key: `POST /api/v1/webhooks/create` returns the id and the
  secret; `.../update` changes only the URL and the secret survives it
  ([create](https://www.airwallex.com/docs/api/webhooks/webhooks/create.md), [update](https://www.airwallex.com/docs/api/webhooks/webhooks/update.md)).
  Events and version are fixed at creation. `bun run dev -- --tunnel` (first run) and `bun run webhook:register` do this.
  Create checks the URL: on a Cloudflare quick tunnel that had not connected it answered `400 invalid_argument`
  "Webhook destination resolves to an internal address" (2026-11-06 01:47), so the first run creates only on a URL already
  proven to reach this machine.
- Activation lag: a new subscription (created 2026-11-03 15:01:32) delivered its first event at 15:08:08; transfers
  moved in between were never delivered. URL updates: one (2026-11-06 00:21:12) was in effect for the next eligible event
  (00:22:23), so within 71 s; two later ones were not: after an update at about 01:31:45, events at 01:32:13-:24 still went
  to the old URL (in effect by 01:36:00), and after one at about 01:43:40 events up to about 01:45:25 did (in effect by
  01:46:20). So up to about three minutes.
- Deliveries arrive about 1-2 s after the event's `created_at` (2026-11-06: `sent` created 00:22:23, received 00:22:24.6;
  `paid`/`failed`/`cancelled` created 00:22:30-31, received 00:22:32.0, :33.2, :34.2, one after another). Source IP
  34.142.189.194 (in the [documented sandbox list](https://www.airwallex.com/docs/developer-tools/webhooks/listen-for-webhook-events.md#whitelist-ip-addresses)),
  user agent `ReactorNetty/1.1.23`, `x-timestamp` in milliseconds and fresh per delivery (2026-11-03).
- For `payout.transfer.*` the event's `data` IS the transfer (the Get transfer body), not `data.object` as for other
  products; `created_at` is written `2026-11-03T15:23:45+0000`, which `Date.parse` rejects until the offset gets a colon.
  Real bodies are in `fixtures/webhooks/` (byte for byte, no secrets).
- The body is not a reliable state: `data.updated_at` on a `paid` event was the `SENT` time (2026-11-03), and simulating
  `FAILED` on a `SENT` transfer emitted `payout.transfer.paid`, then `.failed`, then `.cancelled` (2026-11-06; on
  2026-11-03 the same simulation emitted only `failed` and `cancelled`). A re-read at the first delivery already showed
  `CANCELLED` with code 91402 both times.
- One event id is delivered once per subscription: with two subscriptions, the same `payout.transfer.sent` id arrived twice.
- Funding, processing and scheduled events exist and arrive in bursts; Tessera subscribes to sent/paid/failed/cancelled only.
- A simulator `500 operation_failed` on `PAID` still applied about a minute later (2026-11-03).
- A web-app "test event" is signed with a key carried in the request's own `client-secret-key` header
  ([docs](https://www.airwallex.com/docs/developer-tools/webhooks/listen-for-webhook-events.md)); Tessera refuses it.
- Retries: documented as exponential back-off over about three days until a 200, same event id
  ([overview](https://www.airwallex.com/docs/developer-tools/webhooks/webhooks-overview.md)). Observed 2026-11-06 with an
  endpoint that answered 503 to everything: Airwallex retries in rounds. Within a round, three tries in about three seconds,
  all with the same `x-timestamp` and signature; the next round came 7.5 minutes later (events from 01:24:01, again at
  01:31:37) and 11 minutes later (events from 01:32:12-:19, again at 01:43:05), each round with a fresh `x-timestamp`, so a
  retry is always inside the 5-minute window. A retry round goes to the subscription's URL at that time: the 01:43:05 round
  reached Tessera at its new URL, was accepted, and woke Claude, which replaced the payment (invoice WH-LIVE-MW4AUGG8).
  Two rounds watched, not three days.
- Tunnels: a Cloudflare quick tunnel has a new random hostname per run, no uptime guarantee, 200 requests in flight and no
  SSE ([Cloudflare](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)). On 2026-11-06 the network in use
  blocked Cloudflare's edge (198.41.x.x on 7844 and 443 timed out; the printed URL answered 530). localhost.run
  (`ssh -R 80:127.0.0.1:<port> nokey@localhost.run`, [docs](https://localhost.run/docs/)) worked: a random `*.lhr.life`
  hostname per connection, sometimes a second one on the same connection within seconds (the first then answers
  "no tunnel"), and no client-address header at all (only `host`, `user-agent`, `accept` reached the server).
  `bun run dev -- --tunnel` tries cloudflared, falls back to localhost.run, and points the subscription at every URL.
- End-to-end proof, 2026-11-06 00:22 UTC, API on 4030 with `.data/webhook.db`, `TESSERA_AGENT_ON_EVENT=1`,
  `TESSERA_SWEEP_MS=0`, Claude (`claude-sonnet-5-5`): `bun run webhook:ping -- --url <tunnel>/api/webhooks/airwallex`
  passed all seven checks; `bun run webhook:register -- --url <tunnel>/api/webhooks/airwallex` re-pointed the subscription;
  invoice WH-WAKE-MW48CMZW, transfer `9a58262d-…` moved `SENT` then `FAILED` (`CHANNEL_TIMEOUT`) by the simulator. Ledger:
  `INCIDENT_REACTION` WAIT -> REPLACE credited to event `25bc7f02-…` (`payout.transfer.paid`, re-read `CANCELLED` 91402),
  `AGENT_WAKE` 2.0 s later, `assess_incident` and `replace_payment` both ok, replacement transfer `8681b56a-…` `SCHEDULED`
  at 00:22:38.7 (7.7 s after the failure was triggered), `AGENT_WAKE_FINISHED` with Claude's report; `verifyChain` ok.
- Second proof, 2026-11-06 01:49-01:58 UTC, through `bun run dev -- --tunnel` alone (`AWX_WEBHOOK_ID`/`AWX_WEBHOOK_SECRET`
  blank, `TESSERA_SWEEP_MS=0`): cloudflared gave no reachable URL in 30 s, localhost.run did; subscription
  `wh_PsEG_WVL5NTY36b-Yd-DaW5hpjxv1hlX` created on it at about 01:50 (the old `wh_4dc1…` deleted), first delivery 01:56:42.
  Invoice WH-LIVE-MW4BPWHL: the simulator answered both steps with an error, yet Airwallex moved the transfer (`sent`
  created 01:56:40, `failed` 01:57:40); `WEBHOOK_RECEIVED` `applied` both times (the ledger moved by webhook alone),
  `INCIDENT_REACTION` WAIT -> REPLACE, `AGENT_WAKE` 01:57:44.5, `assess_incident` and `replace_payment` ok, replacement
  `c366a336-…` `SCHEDULED` at 01:57:49.5, `AGENT_WAKE_FINISHED` 01:57:50.9; `verifyChain` ok.
- The 2026-11-03 woken run that did nothing (seq 22/23 in `.data/webhook.db`: one call, no replacement): replayed on a copy
  of that ledger with the same brief, Claude's first call was `assess_incident` with the incident's reference as the id,
  answered "outside the scope of this run"; read-only calls and calls outside a run's scope leave no `AGENT_TOOL_CALL`, so
  the ledger showed nothing. The brief now names the `incidentId`, and `AGENT_WAKE_FINISHED` records every call and the
  closing report.

### FX conversions (observed 2026-11-03 14:55-14:59 UTC and 2026-11-06 00:28-00:37 UTC)

Docs: [current rate](https://www.airwallex.com/docs/api/transactional_fx/rates/current.md),
[create quote](https://www.airwallex.com/docs/api/transactional_fx/quotes/create.md),
[create conversion](https://www.airwallex.com/docs/api/transactional_fx/conversion/create.md),
[conversions](https://www.airwallex.com/docs/api/transactional_fx/conversion.md), builder guide "Booking an FX conversion"
(https://airwallexdev.com/guide). `x-api-version` omitted on every call.

- `GET /fx/rates/current?buy_currency=EUR&sell_currency=USD&buy_amount=100` -> 200 with `rate`, `currency_pair` (`EURUSD`,
  market convention: dollars per euro) and `rate_details` (AWX 1.119628, CLIENT 1.130824 on 2026-11-03); no quote id. The
  rate did not move across a morning of calls; on 2026-11-06 it was 1.133674.
- `POST /fx/quotes/create` (`validity: MIN_1`) -> **200** (the docs say 201), `usage: "MULTI_USE"`, `valid_to_at` =
  `valid_from_at` + 60 s, times written `2026-11-03T14:57:22+0000`; `client_rate`, `awx_rate`, `mid_rate`, and `sell_amount`
  rounded to the nearest cent (€10 -> $11.31; €5 -> $5.65). Tessera's plan rounds up, so a quote may sell a cent less
  than planned (2026-11-06: planned $30.32, quoted $30.31).
- `POST /fx/conversions/create` with a quote -> 201, `status: SETTLED` at once, `conversion_id`, `short_reference_id`
  (`C261103-…`), the `request_id` echoed, sell = the quote's sell. Balances move immediately.
- `GET /fx/conversions?request_id=` -> `{has_more:false, items:[...]}`; unknown -> `items: []`. `GET /fx/conversions/{unknown}`
  -> **400 `not_found`** (not 404).
- A reused `request_id` -> `400 invalid_argument`, `source: "request_id"`, "has been used in the past", **no conversion id**:
  Tessera resolves it by the lookup above, never by a new id.
- The same quote with a new `request_id` -> 201 again: a `MULTI_USE` quote books twice, so single use is Tessera's job (a
  unique quote column).
- Expired quote -> `400 expired_quote` (`source: quoteId`); currencies other than the quote's -> `400 conflict_original_ccy`;
  selling an empty AUD wallet -> `400 insufficient_funds` (`source: conversion`).
- `GET /financial_transactions?source_id=<conversion_id>` -> two lines, `source_type: CONVERSION`: `CONVERSION_BUY` (+€10)
  and `CONVERSION_SELL` (-$11.31), fee 0, `SETTLED`. The Closer ties both legs to these.
- Above about USD 5,000,000 a conversion is refused (`amount_above_limit`, from the docs; not triggered live). Demo staging
  therefore moves at most 2,000,000 per spot conversion.
- Probe conversions 2026-11-03 (2 x €10): `ab07478c-9a0d-4c60-a79b-2f407229b9b8`, `474e8950-bc19-44d4-b268-7524a6967087`;
  EUR 9,999,986.67 -> 10,000,006.67, USD 9,996,963 -> 9,996,940.38.
- Funding proof, 2026-11-06, API on 4020 with `.data/fx.db`, `TESSERA_PAID_HOLD_MS=60000`, Claude (`claude-sonnet-5-5`):
  `POST /api/demo/seed` (00:33:38-00:34:06) staged EUR from 10,000,026.67 to 1,025.00 and seeded seven incidents;
  `ACME-1047-MYW0`'s €25.00 SWIFT transfer `66499bce-…` went `SCHEDULED -> SENT -> CANCELLED` (91402), fee €13.37 kept,
  EUR €1,011.63. The assessment: FUND, buy €26.74 (≈ $30.32 at 1.133674), within the €250 limit. `POST /api/agent/run`:
  21 calls, none refused; `fund_replacement` at 00:34:57 wrote `FUNDING_INTENT` (quote `3c74d92c-…`, valid to 00:35:56),
  conversion `c7725930-93db-4487-baaf-11dc7aaafd07` `SETTLED` 0.4 s later, `FUNDING_BALANCES` EUR 1,038.37 / USD
  21,104,015.08; `replace_payment` sent transfer `4f4cc4fa-2e1c-4a0c-9b4a-15f15875e36b`; EUR then read exactly 1,000.00.
  Simulated `SENT`, `PAID`; after the hold `POST .../close` -> certificate v3 `7564776d…`, funding line expected = actual
  (+2,674 EUR, -3,031 USD minor).
- `bun run chaos convert` (2026-11-06, two €10 SWIFT incidents, EUR floor set to the balance so each was short €23.37):
  killed after Airwallex booked conversion `117bc46f-965d-4525-b555-b6e29616be5b`, recovery found it by `request_id`
  (`ADOPTED_AFTER_AMBIGUITY`); killed before the send, recovery sent the same `request_id` (`d5a30567-…`). Both times a
  second conversion was refused by the lock and the chain verified.

## Tech stack

Core (repo root): Bun 1.4, TypeScript (tsc 7), `bun:sqlite`, `zod` 4, `bun test`. The MCP server is written against the
spec with no SDK, so the only runtime dependency is still `zod`.
Model (built-in agent and evidence reader; MCP clients bring their own): `TESSERA_MODEL_PROVIDER=anthropic` (default,
`ANTHROPIC_API_KEY`) or `openai` (any OpenAI-compatible Chat Completions endpoint: `TESSERA_MODEL_BASE_URL`, optional
`TESSERA_MODEL_API_KEY`, `TESSERA_MODEL_TOOL_FORMAT=native|hermes`), model id in `TESSERA_MODEL`, display name in
`TESSERA_MODEL_LABEL`.
Web (`web/`): Next.js 16 (App Router, Turbopack), React 19, Tailwind 4, Zen Dots + Archivo + JetBrains Mono via `next/font`.
The web app never holds a credential beyond the operator token; it parses every API response with `src/server/wire.ts`.

## Commands

```
bun test                 # unit + integration tests (in-memory SQLite, fake Airwallex)
bun run typecheck        # tsc --noEmit (core)
bun run smoke            # real sandbox: pay, fail, deny replacement, human-approved replacement, certify
bun run chaos            # real sandbox: kill -9 mid-create and mid-conversion, recover, assert one transfer / one conversion
bun run commander        # real sandbox: wait / auto-replace / escalate decided by policy
bun run evidence:live    # real Claude reads four supplier messages
bun run redteam          # offline, no keys: fifty attacks on the invariants, with a scoreboard
bun run agent            # real sandbox + real Claude: an agent works seven incidents through the toolbox
bun run agent -- --adversary   # the same toolbox, but the agent is told to get a supplier paid twice
bun run agent -- --seed-only   # set the seven incidents up and stop, to watch them in the console
bun run mcp              # the toolbox over stdio, for any MCP client (Claude Code/Desktop, Codex, Cursor, Gemini CLI, Hermes Agent, ...)
bun run demo             # no keys: API + console on a simulated Airwallex, scripted agent (TESSERA_OFFLINE=1)
bun run dev              # API + console on the .env credentials, one command
bun run dev -- --tunnel  # live, plus a public tunnel to the webhook listener (cloudflared, else localhost.run); creates / re-points the subscription
bun run webhook:register -- --url https://<public>/api/webhooks/airwallex   # create / re-point the sandbox subscription; --delete
bun run webhook:ping -- --url https://<public>/api/webhooks/airwallex       # signed checks + operator routes unreachable
bun run setup            # creates .env secrets and the sandbox beneficiaries (US/USD/LOCAL, DE/EUR/SWIFT)
bun run scale            # 100 mixed incidents offline, metrics, invariant check
bun run smoke:offline    # in-process demo end to end: seed, scripted agent, invariant, hash chain (CI)
bun run api              # Tessera API on 127.0.0.1:4010
cd web && bun run dev    # console only, on 127.0.0.1:3100   (bun run build && bun run start for production)
```

## Structure

```
src/money.ts             minor-unit conversion
src/canonical.ts         canonical JSON + sha256
src/errors.ts            domain errors
src/airwallex/           zod schemas, PayoutApi interface, REST client, webhook verifier, FakePayoutApi (offline + tests)
src/domain/playbook.ts   failure code -> class -> replacement policy
src/ledger/ledger.ts     SQLite obligations/attempts/conversions/events/certificates, one-open-attempt and one-conversion-per-replacement indexes, hash chain
src/ledger/conversions.ts conversion rows, lock states, and their replay for verifyChain
src/funding/             funding executor (book / recover / sync) and funding approvals (own MAC domain)
src/approval/approval.ts HMAC approvals
src/gateway/gateway.ts   exactly-once submit / recover / sync / webhook sync / human lock release
src/closer/              reconciliation, certificate schemas (pure) and signing
src/commander/           decision policy, evidence reader, approvals, model providers: model.ts (shared turn shape, retries),
                         anthropic.ts, openai.ts (any OpenAI-compatible endpoint; native or Hermes tool calls), model-env.ts (env selection)
src/agent/               the agent surface: toolbox (13 typed tools), provider-neutral tool-use loop, MCP server (stdio)
src/server/              HTTP API (api.ts), process entry (main.ts), shared wiring (runtime.ts), metrics, .eml parsing, wire contract (wire.ts, pure zod),
                         webhook-only public listener (webhook-listener.ts), webhook handler (webhook.ts), reactions (reactions.ts),
                         event-driven agent runs (wake.ts), the one-agent-at-a-time gate and run budget (agent-runs.ts)
src/demo/                the seven ACME incidents, sandbox wallet staging (stage-wallet.ts), scripted agent and adversary, keyword reader
web/                     Next.js operations console (board, incident page, proxy.ts host guard, same-origin API proxy)
tests/                   behavior tests; tests/redteam/ holds the fifty attacks
scripts/                 dev runner (--tunnel), setup, scale, offline smoke, sandbox smoke, chaos, commander demo, live evidence, agent demo, red team,
                         webhook-register.ts (subscription over the API), webhook-ping.ts (endpoint check before registering)
fixtures/                failure-codes.json (captured from the sandbox); webhooks/ (real deliveries, raw bodies)
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
- The agent's reach is the toolbox and nothing else. There is no tool that creates a transfer, signs an approval, or
  edits an amount or beneficiary. `escalate_to_human` is always allowed because it only removes the agent's authority.
- Untrusted text never reaches the agent. A quarantined reader returns booleans and a credit amount; the model's free-text
  summary is withheld from tool output (a person sees it in the console). No part of a sender's address is shown: the agent
  gets an opaque sender id (sha256 of the address) and whether its domain matches the incident's earlier messages. Outside MCP the
  agent names a message in the ledger's inbox and cannot supply message text itself; over MCP the client does, which can only add caution.
  An escalation reason written by one agent is shown to others only as a hash.
- Evidence accumulates (`effectiveEvidence`): risk flags from any later record stay set, and only an operator's manual entry resets them.
- The Commander allows CLOSE only when nothing blocks it (not escalated, no open non-receipt claim, hold window passed), and the
  toolbox's `reconcile_and_close` refuses unless it does. The Closer re-reads the transfer from Airwallex before certifying.
- Payouts are same-currency; a payout wallet line in another currency blocks certification. A replacement may be funded by a
  conversion: `planFunding` buys the shortfall (amount + the last attempt's fee + the reserve floor - the balance, rounded up to
  the smallest conversion) from the first `fundingSources` wallet that keeps its own floor. FUND is allowed only where REPLACE
  would otherwise be; within `autoConvertLimitMinor` the Commander books it on a 1-minute quote (re-planned on drift above
  `maxRateDriftBps`, age above `maxQuoteAgeMs`, or expiry, three times at most), above it a person approves a recorded
  15-minute quote in two steps (fingerprint). The executor re-reads the wallets, refuses any buy other than the exact
  shortfall or one that breaks the source's floor, writes the intent first, books each quote once, and allows one INTENT /
  BOOKED / SETTLED conversion per replacement (partial unique index). The replacement is then decided on balances read after
  settlement, and the certificate (v3) ties both legs to `CONVERSION_BUY` / `CONVERSION_SELL`.
- A webhook (HMAC-SHA256 of timestamp + raw body, 5 minute tolerance, deduplicated by event id) is only a hint: the transfer is
  re-read. A background sweep (`TESSERA_SWEEP_MS`) recovers stray intents and syncs live transfers even if webhooks are lost.
  Webhooks reach a listener of their own (`TESSERA_WEBHOOK_PORT`, one route, POST only); the operator API is never tunnelled.
  Every taken delivery is chained (`WEBHOOK_RECEIVED`) with the dedupe row; a failed re-read answers 503 so Airwallex redelivers.
- A bank-side transfer change (webhook or sweep) gets one `INCIDENT_REACTION`: the Commander's decision with the change taken
  back and applied, on the same balances. If it changed into something an agent can act on and `TESSERA_AGENT_ON_EVENT=1`
  (never in a public demo), an agent run is woken for that incident only: debounced, single flight per incident, one agent run
  per process, capped per incident and overall from the ledger, recorded as `AGENT_WAKE` / `AGENT_WAKE_FINISHED`. The agent's
  own actions are never bank news. A scoped run's brief names the incident's reference and its `incidentId`.
- A person releases a stuck lock (`resolveAttempt`) only after Airwallex confirms it, with a written note: the transfer is CANCELLED,
  or the attempt never reached Airwallex (an INTENT with no transfer for its request_id, at least 10 minutes old, so a slow send cannot
  still land). A transfer in an approval state (REJECTED, BLOCKED, RECALLED) stays locked until CANCELLED, because Airwallex lets it be
  resubmitted. The gateway re-reads the attempt before every send, and never sends for an escalated obligation. A transfer that shows up
  for a released attempt is recorded (TRANSFER_AFTER_ABANDON) and escalated. A person approves a risky replacement in two steps: the
  approval is bound to the incident and to the assessment (evidence hash) they reviewed.
- Every mutating tool call, and every refusal, is appended to the hash-chained ledger under the agent's name.
- Supplier-facing text is a draft for a person. A draft is allowed only when the Commander allows that kind of reply, may not
  carry account details, links, an email address or a promise of another payment, and carries facts written by code.
- A console agent run is scoped, one at a time, step- and call-limited, and survives in-app navigation; closing the tab or pressing stop
  cancels it at the next step. "Try to break it" (a hostile brief for the same agent) exists only when the API is on the sandbox or offline.

## Boundaries

- Always: sandbox only; keys from env; typed tools; tests for invariants.
- Ask first: new runtime dependencies; anything touching production credentials.
- Never: commit `.env`; hardcode fees; create a transfer with a new `request_id` after an ambiguous outcome.

## Open questions

- Sending approved drafts through a real mail integration, and fetching supplier mail instead of pasting it.
- Real multi-user sign-in and per-person approval limits.
- External anchoring of the ledger head; KMS-held approval keys.
