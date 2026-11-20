# Walkthrough: supplier issues

A guided path through the console for anyone testing Tessera. It takes about five minutes and needs no keys:

```sh
bun install && (cd web && bun install)
bun run demo          # offline: simulated Airwallex, no keys, no money; opens http://127.0.0.1:3100
```

With an Airwallex sandbox account and a model in `.env` (see the README, *Run it*), `bun run dev` runs the same path
against the real sandbox.

## What you start with

Press **Investigate supplier issues** in the control room (it is also in the Next bar and in ⌘K). Six supplier payments
went out on the last run, each approved by a person and paid through Airwallex, and every one of them is now stuck in a
different way.

The control room shows them as a case map: a dotted globe with each supplier pinned at its headquarters
(`web/lib/supplier-places.ts` says where each location comes from), coloured by where its issue stands. Click a pin for
that supplier's case (the problem, the invoice, the bank, where it landed, and the whole trail); **Live activity**
streams every move as it lands, and **See all activity** opens the full history. The **Lanes** view shows the same issues
as rows, read left to right:

| The problem (red) | The agent, step by step | Where it landed (green) |
|---|---|---|
| What the supplier is facing, written once when the case opens | Every move as it hits the ledger: the agent's tool calls and the policy's answers, a person's signature, Airwallex, Visa | Read from the ledger state: unsolved (red), in progress (blue), waiting on you (amber), solved or certified (green) |

Only the problem's wording is authored (the `CASE_OPENED` brief in `src/demo/morning.ts`). Every step after it and
every outcome is derived from the hash-chained ledger by `src/server/cases.ts`, so a lane can never claim more than
happened.

## The six cases, and what you should see

| Supplier | The problem | What the agent does | Where a person comes in | Where it lands |
|---|---|---|---|---|
| **Modal** | Bounced at the bank (91402); Modal is past due and chasing | Reads the email, checks Airwallex (money is back), and asks for a **single-use Visa card** for exactly the invoice | **A person authorizes the card.** The agent cannot sign it, and policy refuses to pay with it until someone does | Once authorized, the agent pays Modal's checkout **through Visa TAP**, signed with its key. Visa clears it; certified |
| **Prime Intellect** | Still in transit; they want it sent again | Checks: the original is still moving. Holds, and drafts a status reply | Sends the reply | The original lands on its own shortly after: paid once, holding was right |
| **Replicate** | Timed out at the bank (91402) | Replaces it alone: within the automatic limit, original provably cancelled | None | Paid once by the replacement; certified |
| **LangChain** | Returned as a possible duplicate (91301) | Refuses to pay again and hands it over with its reasons | Releases a second payment **in writing** only if nothing arrived | Paid once, released in writing |
| **fal** | Paid, but fal says it never arrived | Checks: Airwallex shows it paid. Drafts proof of payment, never a second payment | Sends the proof | Proof sent, not paid twice |
| **Framer** | "Overdue? Pay our new bank" from framer-invoices.com | Reads it through the quarantined reader, then **investigates** it in code: sender against the vendor record (a look-alike of framer.com), the IBAN against the account on file, "overdue" against the ledger, orders aimed at an assistant, pressure. Hands it over with the verdict | Calls Framer on the number on file | Impersonation stopped: nothing moved to the new account |

## Steps

1. **Investigate supplier issues.** Six red pins.
2. In the agent panel, **Let the agent work**. Watch the agent's reasoning stream, the pins change colour and Live
   activity fill. Replicate is replaced, Prime Intellect held, Framer stopped.
3. Open the amber cases. **Next on your payouts** (or the queue) shows Modal's card waiting for a signature. Write a
   reason and sign it. The card is handed to the agent, which pays Modal's checkout through Visa TAP.
4. **Test the guardrails** on any invoice: the same agent is told to cheat (pay twice, pay by card as well, certify
   early). Every move is refused by policy, and the refusals show on that invoice's trail.
5. Where only the supplier's word is open (fal, Prime Intellect once it lands, Framer after your call), open its pin and
   press **Mark it received**, or **Confirm it arrived** in the queue. Supplier issues certify themselves once paid,
   held and undisputed.
6. Open any incident for its evidence chain and signed certificate.

To start over: your avatar (top right) > **Reset control room**. A live workspace moves on to a fresh ledger (the old
one stays on disk); an offline one starts empty.

## The Visa TAP rule

**The agent may ask for a card; only a person can authorize it; the agent pays through Visa TAP only after that.**
It is enforced in code, not in the prompt:

- `CardDesk.approve` refuses any `agent:` signer ("an agent cannot sign a card; a person must").
- Policy refuses `PAY_BY_CARD` while the card is `PENDING`, so the agent's pay call is refused and a second pass only waits.
- The card's terms are the invoice's (exact amount, the supplier as its one merchant, single use) and it holds the
  invoice's duplicate lock: no transfer can follow it.
- The agent pays the supplier's checkout through Visa's Trusted Agent Protocol; the merchant verifies the agent's
  signature before it charges.

`tests/morning.test.ts` covers all of this.

## On the live sandbox

```sh
bun run scripts/verify-card-sandbox.ts   # one $25 card, end to end: proves Issuing and TAP work on this account
bun run dev
```

If `verify-card-sandbox` fails on issuing, Visa TAP is off on that account and Modal is replaced by bank transfer
instead. On the sandbox, **Investigate supplier issues** takes about half a minute while Airwallex cancels the failed
transfers; offline it is instant.

## What runs where

| Piece | File |
|---|---|
| The six cases, their briefs and the supplier messages | `src/demo/morning.ts` |
| Setting them up through the real path (door, approval, gateway, simulator) | `src/server/requests.ts` (`morning()`), `POST /api/supplier-issues` |
| Problem, steps and outcome, derived from the ledger | `src/server/cases.ts`, on every board summary as `case` |
| The delayed transfer landing once it has been held | `src/server/bank-clock.ts` (sandbox and offline only) |
| A reply already sent is not offered again | `repliesSent` in `src/commander/policy.ts` |
| The case map and the lanes | `web/components/dashboard/cases-panel.tsx`, `case-globe.tsx`, `case-map.tsx` |
| The globe's land | `web/lib/globe-dots.ts` (Natural Earth 1:50m, public domain) |
| Each supplier's headquarters, and where it comes from | `web/lib/supplier-places.ts` |
| The card hand-off to the agent after a person authorizes | `web/components/agent/hand-off.ts` |
