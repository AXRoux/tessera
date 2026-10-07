# Tessera

Agents can read your balances. **Tessera lets them move money without ever paying a supplier twice.**

A tessera is a single tile. Each payment is one tile in the picture, and the picture is only right if none of them repeats.

Built for the Airwallex Agentic Banking Hackathon, starter kit 3 (Payment Ops Incident Commander), on the Airwallex
sandbox. Sandbox only: no real money moves.

When a supplier says a transfer never arrived, the agent has to decide: wait, replace, or escalate. Tessera makes that
decision safe in three layers.

| Layer | What it guarantees |
|---|---|
| **Payout gateway** | The database refuses a second open payout for an obligation. The intent is written before any network call; an ambiguous result is resolved by looking the `request_id` up, never by minting a new one. Survives `kill -9`. |
| **Exception handling** (`src/commander`) | Wait, replace, request a correction, send proof, or escalate, decided by code against a failure playbook covering all 32 Airwallex failure codes. Claude reads the supplier's message; code checks what it claims. |
| **Reconciliation** (`src/closer`) | Checks every wallet line against Airwallex, waits out a hold (a `PAID` transfer can still be returned), then signs a certificate with a tamper-evident fingerprint. |

The model never holds a credential and never decides what is allowed. See [SPEC.md](SPEC.md) for the verified sandbox
behaviors the design rests on.

## Run it

Requirements: [Bun](https://bun.sh) 1.4+, Node 20.9+ (Next.js 16), an Airwallex sandbox account, and optionally an
Anthropic key.

```sh
cp .env.example .env        # then fill it in (see below)
bun install
(cd web && bun install)

bun run api                 # terminal 1: Tessera API, 127.0.0.1:4010
cd web && bun run dev       # terminal 2: web app, http://127.0.0.1:3100
```

`web/.env.local` needs only `TESSERA_API_URL=http://127.0.0.1:4010` and the same `TESSERA_API_TOKEN` as the root `.env`.
For a production build: `cd web && bun run build && bun run start`.

Create a sandbox beneficiary nicknamed `spike-us-supplier` (US, USD, LOCAL, ABA routing `021000021`) or set
`TESSERA_BENEFICIARY_ID`. Without `ANTHROPIC_API_KEY` and `TESSERA_MODEL` the app still works; supplier evidence is
entered by hand instead of read by Claude.

## Demo path (about 3 minutes)

1. **Send a test invoice.** The ledger records the intent, then the transfer is created.
2. **Mark sent**, then paste a supplier email asking to change bank details and press **Read with Claude**. The
   recommendation flips to *Hand to a person*, marked critical, because that is the payment-fraud pattern.
3. On another invoice, **fail the transfer** with *Duplication return*. Try to release it with the reason "ok": refused.
   Give a real reason and it goes out under a new request ID, recorded under your name.
4. On a third, **mark paid** and try **Reconcile and certify**: refused inside the hold window. Once it passes, the
   Closer checks every wallet line and signs the certificate.

## Prove it

```sh
bun test                    # 111 behavior tests, in-memory SQLite and a fake Airwallex
bun run typecheck && (cd web && bun run typecheck)
bun run smoke               # real sandbox: PAID, late bank return, denied then human-approved replacement, certificate
bun run chaos               # real sandbox: SIGKILL mid-create (both sides of the network call): exactly one transfer
bun run commander           # real sandbox: wait, auto-replace, escalate
bun run evidence:live       # real Claude on four supplier messages, including a prompt injection
```

## Layout

```
src/ledger      SQLite ledger, one-open-attempt index, hash-chained events
src/gateway     exactly-once submit, recover, sync
src/domain      failure playbook (32 codes -> class -> replacement policy)
src/approval    HMAC approvals bound to amount, currency, beneficiary, evidence
src/closer      reconciliation and signed certificates
src/commander   decision policy, evidence reader, Anthropic transport
src/server      HTTP API and the wire contract the web app parses with
web             Next.js 16 operations console
```

## Security notes

- `.env` is gitignored. The operator token lives only in the Next.js server process: browsers talk to a same-origin
  proxy that adds it, and cross-origin writes are refused.
- The API and web server bind to `127.0.0.1`. The web app has no login: whoever can reach it is the operator.
- Every human approval is stamped server-side with the configured operator identity, never one sent by the browser.
