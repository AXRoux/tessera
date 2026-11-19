"use client";

import { useId, useState } from "react";
import { Acknowledged, api } from "@/lib/client-api";
import { ago, money } from "@/lib/format";
import type { RunAction } from "@/lib/use-incident";
import type { IncidentView } from "../../../src/server/wire";
import { VisaCard } from "../cards/visa-card";
import { handOffLine, useCardHandOff } from "../agent/hand-off";
import { Btn } from "../kit/metal";
import { Field, TextArea } from "./fields";

/** The API refuses a signature whose note is shorter than this (WRITTEN_NOTE_MIN_CHARS). */
const NOTE_MIN = 10;

function Step({ n, label, state }: { n: number; label: string; state: "done" | "now" | "later" }) {
  return (
    <li className="flex items-center gap-2.5">
      <span
        className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[10.5px] font-semibold ${
          state === "done" ? "bg-accent text-white" : state === "now" ? "ring-1 ring-accent text-accent" : "ring-1 ring-fg/20 text-fg/40"
        }`}
      >
        {state === "done" ? "✓" : n}
      </span>
      <span className={`text-[13.5px] ${state === "later" ? "text-fg/45" : "text-fg/85"}`}>{label}</span>
    </li>
  );
}

/**
 * Paying the invoice by single-use Visa card, where a replacement transfer would be allowed: ask for the card (its terms
 * are the invoice's), a person signs it, the agent pays the supplier's checkout through Visa's Trusted Agent Protocol,
 * the charge is proved against what was signed, and the invoice is certified with the card. Shown only when the card
 * rail applies to this invoice.
 */
export function CardPanel({ view, operator, busy, run }: { view: IncidentView; operator: string; busy: string | null; run: RunAction }) {
  const noteId = useId();
  const [note, setNote] = useState("");
  const handOff = useCardHandOff();
  const id = view.obligation.id;
  const decision = view.assessment?.decision;
  const card = view.invoiceCard ?? null;
  const allowed = Boolean(decision?.allowed.includes("PAY_BY_CARD"));
  const holds = card !== null && ["PENDING", "ISSUING", "ACTIVE", "FROZEN", "SPENT"].includes(card.state);
  if (!allowed && !holds && card === null) return null;

  const amount = money(view.obligation.amountMinor, view.obligation.currency);
  const name = operator.split("@")[0];
  const proof = card?.settlements.at(-1) ?? null;
  const checkout = card?.checkouts.findLast((c) => c.status === "APPROVED") ?? null;
  const step = !holds ? 0 : card!.state === "PENDING" ? 1 : card!.state === "ACTIVE" && card!.spentMinor === 0 ? 2 : proof ? 4 : 3;
  const at = (n: number): "done" | "now" | "later" => (n < step + 1 ? "done" : n === step + 1 ? "now" : "later");

  const ask = () =>
    run("card", async () => {
      await api(`obligations/${id}/card`, Acknowledged, { method: "POST", body: {} });
      return { tone: "ok", title: "Card asked for", lines: [`A single-use Visa card for exactly ${amount} now waits for a signature. No transfer can be made while it holds the invoice.`] };
    });
  // A person authorizes; once Airwallex has issued the card, the agent takes it and pays through Visa TAP.
  const sign = (cardId: string) =>
    run("card-sign", async () => {
      const signed = await api(`cards/${cardId}/approve`, Acknowledged, { method: "POST", body: { note: note.trim() } });
      setNote("");
      const state = String(signed.state);
      if (state !== "ACTIVE") {
        return { tone: "ok", title: "Card authorized", lines: [`Signed by ${operator}. Airwallex is ${state === "FAILED" ? "refusing to issue it; see why below" : "issuing it"}.`] };
      }
      return {
        tone: "ok", title: "Authorized: the card is the agent's to pay with",
        lines: [`Signed by ${operator}. Airwallex issued it with the invoice's terms as its controls.`, handOffLine(handOff(id, state), amount)],
      };
    });
  const decline = (cardId: string) =>
    run("card-decline", async () => {
      await api(`cards/${cardId}/decline`, Acknowledged, { method: "POST", body: { note: note.trim() } });
      setNote("");
      return { tone: "ok", title: "Card declined", lines: ["The invoice is released: a replacement transfer may be made instead."] };
    });
  const pay = () =>
    run("card-pay", async () => {
      const result = await api(`obligations/${id}/card/pay`, Acknowledged, { method: "POST", body: {} });
      const outcome = String(result.outcome);
      return outcome === "PAID"
        ? { tone: "ok", title: "Paid through Visa TAP", lines: [`The supplier's checkout verified the agent's signature and charged exactly ${amount}.`] }
        : { tone: "refused", title: "The checkout did not go through", lines: [String(result.next ?? "Assess again.")] };
    });

  return (
    <div className="tile space-y-4 rounded-[22px]! p-4">
      <div>
        <span className="kicker block">Pay by Visa card</span>
        <p className="mt-1.5 text-[13px] leading-relaxed text-fg/60">
          Instead of a second transfer: one single-use card for exactly {amount}, payable only to this supplier, sharing the invoice&rsquo;s lock so it can never be paid twice. A person signs it; the agent
          pays the supplier&rsquo;s checkout through Visa&rsquo;s Trusted Agent Protocol.
        </p>
      </div>

      {card ? (
        <div className="mx-auto w-full max-w-[280px]">
          <VisaCard card={card} compact />
        </div>
      ) : null}

      <ol className="space-y-1.5">
        <Step n={1} label="Ask for the card (terms from the invoice)" state={at(1)} />
        <Step n={2} label="A person authorizes it (the agent cannot)" state={at(2)} />
        <Step n={3} label="The agent pays through Visa TAP, once authorized" state={at(3)} />
        <Step n={4} label="Charge cleared and proved" state={at(4)} />
      </ol>

      {!holds && allowed ? (
        <>
          {card ? <p className="text-[13px] leading-relaxed text-fg/55">The last card was {card.state.toLowerCase()}{card.lastError ? `: ${card.lastError}` : ""}.</p> : null}
          <Btn block busy={busy === "card"} onClick={() => void ask()}>
            Ask for a card for {amount}
          </Btn>
        </>
      ) : null}

      {!holds && !allowed && card ? (
        <p className="text-[13px] leading-relaxed text-fg/55">
          The card was {card.state.toLowerCase()}
          {card.lastError ? `: ${card.lastError}` : ""}. {decision?.blocked.find((b) => b.action === "PAY_BY_CARD")?.reason ?? "Paying by card is not among the safe moves right now."}
        </p>
      ) : null}

      {card && card.state === "PENDING" ? (
        <div className="space-y-3">
          <p className="text-[13px] leading-relaxed text-fg/60">
            Asked for by {card.byAgent ? "the agent" : card.requestedBy} {ago(card.createdAt)}: &ldquo;{card.reason}&rdquo;
          </p>
          <Field label="Why is it safe to pay this supplier by card?" htmlFor={noteId} hint={note.trim().length < NOTE_MIN ? "A sentence, in your own words." : undefined}>
            <TextArea id={noteId} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Called the supplier on the number we hold; they take card for this invoice." maxLength={500} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Btn tone="secondary" disabled={note.trim().length < NOTE_MIN} busy={busy === "card-decline"} onClick={() => void decline(card.id)}>
              Decline
            </Btn>
            <Btn disabled={note.trim().length < NOTE_MIN} busy={busy === "card-sign"} onClick={() => void sign(card.id)}>
              Sign as {name}
            </Btn>
          </div>
        </div>
      ) : null}

      {card && card.state === "ACTIVE" && card.spentMinor === 0 ? (
        <div className="space-y-2">
          <Btn block disabled={!allowed} busy={busy === "card-pay"} onClick={() => void pay()}>
            Have the agent pay {amount} through Visa TAP
          </Btn>
          <p className="text-[12.5px] leading-relaxed text-fg/50">
            Signed with the agent&rsquo;s key over this invoice&rsquo;s own payment path; the merchant verifies it before it charges. The amount is the invoice&rsquo;s, never typed.
          </p>
        </div>
      ) : null}

      {card && card.spentMinor > 0 ? (
        <ul className="space-y-1 text-[13px] leading-relaxed text-fg/70">
          <li>
            Charged {money(card.spentMinor, card.currency)}
            {checkout ? `, order ${checkout.orderId ?? "?"}, TAP signature ${checkout.tapVerified ? "verified" : "not verified"}` : ""}
          </li>
          <li>{proof ? (proof.matches ? "Proved against every signed term" : "Does NOT match what was signed: a person must look") : "Waiting for the charge to clear"}</li>
          {proof && decision?.recommended === "WAIT" && decision.recheckAt ? <li>Final once the hold window ends, at {new Date(decision.recheckAt).toLocaleTimeString()}</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
