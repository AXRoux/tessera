# The five-minute demo: this morning's stuck payments

The demo starts with the problem already in motion. Six supplier payments went out on the last run, each approved by
a person and paid through Airwallex. This morning, every one of them is stuck in a different way. The control room
shows each one as a **lane**, read left to right:

| The problem (red) | The agent, step by step | Where it landed (green) |
|---|---|---|
| What the supplier is facing, written once when the case opens | Every move as it hits the ledger: the agent's tool calls and the policy's answers, a person's signature, Airwallex, Visa | Read from the ledger state: unsolved (red), in progress (blue), waiting on you (amber), solved or certified (green) |

Only the problem's wording is authored (the `CASE_OPENED` brief in `src/demo/morning.ts`). Every step after it and
every outcome is derived from the hash-chained ledger by `src/server/cases.ts`, so a lane can never claim more than
happened. Click a lane to open its whole trail in sentences.

## The six cases

| Supplier | The problem | What the agent does | Where a person comes in | Where it lands |
|---|---|---|---|---|
| **Modal** | Bounced at the bank (91402); Modal is past due and chasing | Reads the email, checks Airwallex (money is back), and asks for a **single-use Visa card** for exactly the invoice | **A person authorizes the card.** The agent cannot sign it, and policy refuses to pay with it until someone does | The moment it is authorized, the agent pays Modal's checkout **through Visa TAP**, signed with its key. Visa clears it; certified |
| **Prime Intellect** | Still in transit; they want it sent again | Reads, checks: the original is still moving. Holds, and drafts a status reply | Sends the reply | The original lands on its own about 30s after the agent held it: paid once, holding was right |
| **Replicate** | Timed out at the bank (91402) | Replaces it alone: within the automatic limit, original provably cancelled | None | Paid once by the replacement; certified |
| **LangChain** | Returned as a possible duplicate (91301) | Checks, refuses to pay again, hands it over with its reasons | Confirms with LangChain; releases a second payment **in writing** only if nothing arrived | Paid once, released in writing |
| **fal** | Paid, but fal says it never came | Reads, checks: Airwallex shows it paid. Drafts proof of payment, never a second payment | Sends the proof | Proof sent, not paid twice |
| **Framer** | "Overdue? Pay our new bank" from framer-invoices.com | Reads it through the quarantined reader (bank change, orders aimed at the agent, ignored) and hands it over | Calls Framer on the number on file | Fraud stopped: nothing moved to the new account |

## The Visa TAP rule, in one line

**The agent may ask for a card; only a person can authorize it; the agent pays through Visa TAP only after that.**
It is enforced in code, not in the prompt:

- `CardDesk.approve` refuses any `agent:` signer ("an agent cannot sign a card; a person must").
- Policy refuses `PAY_BY_CARD` while the card is `PENDING` ("The card has not been signed yet"), so the agent's pay
  call is refused and a second pass only waits.
- The card's terms are the invoice's (exact amount, the supplier as its one merchant, single use) and it holds the
  invoice's duplicate lock: no transfer can follow it.
- Once a person signs and Airwallex issues the card, the console hands it to the agent at once (a run on that invoice
  only). The agent assesses again and pays the supplier's checkout through Visa's Trusted Agent Protocol; the merchant
  verifies the agent's signature before it charges.

`tests/morning.test.ts` holds all of this: the agent cannot sign, cannot pay early, and pays through TAP only after the
authorization, which comes first on the record.

## Before you present (5 minutes)

```sh
bun run scripts/verify-card-sandbox.ts   # live only: one $25 card, end to end. Proves Issuing and TAP work on this account
TESSERA_DB=.data/demo.db bun run dev     # live: Airwallex sandbox + the configured model. Or `bun run demo` (offline, no keys)
```

- If `verify-card-sandbox` fails on issuing, Visa TAP is off on that account and Modal will be replaced by bank transfer
  instead. Fix that before presenting, or present offline (`bun run demo`), where the card rail always works.
- Press **Load this morning** in the control room before you start talking (offline it is instant; on the sandbox it
  takes about half a minute while Airwallex cancels the failed transfers).
- Browser at 1440×900 or larger. Light or dark both work.

## The script (4:45)

| Time | Do | Say |
|---|---|---|
| **0:00** | The control room, six red lanes. Point at the headline *6 stuck → 0 solved*. | "Six supplier payments went out yesterday. This morning every one is stuck, and each wrong answer costs money: pay twice, pay a fraudster, or leave a supplier waiting." |
| **0:30** | Agent panel: **Let the agent work 6 invoices**. Watch the right column stream, the lanes fill. | "The agent reads each supplier's email through a quarantined reader, checks Airwallex, asks the policy, and acts only on what the code allows. Replicate: it replaces the payment itself. Prime Intellect wants it sent again: the original is still moving, so it holds. Framer's 'new bank' email: stopped." |
| **1:30** | Point at the amber lanes. Next on your payouts → **MDL-2611 · Sign card** (or Queue). | "Some things the agent may not do alone. Modal is past due, so it asked for a single-use Visa card for exactly this invoice. It cannot sign that card. I can." |
| **2:00** | In the queue, write a reason and **Sign as ops**. Back to the control room. | "Once I authorize it, the card is the agent's to pay with. It pays Modal's checkout through Visa's Trusted Agent Protocol, signed with its own key; the merchant verifies the signature before it charges." |
| **2:45** | Modal's lane turns green. Click it: the full trail. Prime Intellect has landed by itself. | "Problem, every step, and where it landed, all read from the ledger. And Prime Intellect: holding was right. The original arrived. Paid once." |
| **3:15** | **Test the guardrails on PI-419**. Red refusals stream; the lane shows *Refused ×8*. | "Now the same agent, told to cheat: pay twice, pay by card as well, certify early. Every one refused by code." |
| **3:50** | **Let the agent work** again: Replicate and Modal certify. Open one incident: Evidence, Certificate. | "Reconciled line by line against Airwallex and sealed." |
| **4:20** | The headline, *6 stuck → 5 solved*, and the amber that is left. | "What is left is a person's call, with the agent's reasoning attached. Agents act, policy decides, people sign, and every cent is proved." |

## What runs where

| Piece | File |
|---|---|
| The six cases, their briefs and the supplier messages | `src/demo/morning.ts` |
| Setting them up through the real path (door, approval, gateway, simulator) | `src/server/requests.ts` (`morning()`), `POST /api/demo/morning` |
| Problem, steps and outcome, derived from the ledger | `src/server/cases.ts`, on every board summary as `case` |
| The delayed transfer landing once it has been held | `src/server/bank-clock.ts` (sandbox and offline only) |
| A reply already sent is not offered again | `repliesSent` in `src/commander/policy.ts` |
| The lanes | `web/components/dashboard/cases-panel.tsx` |
| The card hand-off to the agent after a person authorizes | `web/components/agent/hand-off.ts` |
