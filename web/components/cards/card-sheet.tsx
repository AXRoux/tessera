"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import type { CardView } from "../../../src/server/wire";
import { Acknowledged, api, ApiProblem } from "@/lib/client-api";
import { cardsChanged } from "@/lib/use-cards";
import { money } from "@/lib/format";
import { mccName } from "@/lib/mcc";
import { Field, TextArea, TextInput } from "../console/fields";
import { Icon } from "../landing/icons";
import { Btn } from "../kit/metal";
import { Select } from "../kit/select";
import { Chip, Kicker, Tile, Tray, TrayHead } from "../kit/widgets";
import { VisaCard } from "./visa-card";

const NOTE_MIN = 10;
/** A merchant category no card category allows: what a charge the card was not signed for looks like. */
const OFF_LIST = "7995";

const CheckoutAnswer = Acknowledged;

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <Kicker>{label}</Kicker>
      <div className="mt-0.5 truncate text-[13px]">{children}</div>
    </div>
  );
}

const CHECK_LABEL: Record<CardView["settlements"][number]["checks"][number]["check"], string> = {
  merchant: "Merchant",
  cap: "Within the cap",
  category: "Merchant category",
  currency: "Currency",
  single_use: "Single use",
  signed: "Signed by a person",
};

/** A charge accepted by the network that Airwallex has not posted to the wallet yet (REST reads it PENDING until then). */
const settling = (c: CardView["charges"][number]) => c.type === "CLEARING" && c.status === "PENDING";

/** A charge's status in words. A CLEARING is accepted whatever its status says; PENDING only means not posted yet. */
const chargeWord = (c: CardView["charges"][number]): string => {
  if (c.status === "FAILED") return "declined";
  if (c.type === "REFUND") return "refunded";
  if (c.type === "AUTHORIZATION") return "authorised";
  if (c.type === "CLEARING") return settling(c) ? "settling" : "settled";
  return c.status.toLowerCase();
};

/**
 * What happened to the money after the card was used: the charge clears, Tessera proves it against what the person
 * signed at once, and Airwallex posts it to the wallet in its own time. The card's equivalent of a payout's closure
 * certificate.
 */
function Purchase({ card }: { card: CardView }) {
  if (card.spentMinor === 0 && card.heldMinor === 0) return null;
  const posting = card.charges.some(settling);
  const steps = [
    { label: "Signed", done: card.approvedBy !== null },
    { label: "Charged", done: true },
    { label: "Cleared", done: card.spentMinor > 0 },
    { label: "Proved", done: card.settlements.length > 0 },
  ];
  return (
    <Tile className="rounded-[20px]! px-4 py-3.5">
      <div className="flex items-center justify-between gap-2">
        <Kicker>The purchase</Kicker>
        {card.heldMinor > 0 && card.spentMinor === 0 ? (
          <Chip tone="warn" pulse>
            Authorised
          </Chip>
        ) : card.settlements.some((s) => !s.matches) ? (
          <Chip tone="bad">Does not match</Chip>
        ) : card.settlements.length > 0 ? (
          <Chip tone="accent">Proved</Chip>
        ) : null}
      </div>
      <ol className="mt-3 grid grid-cols-4 gap-1.5">
        {steps.map((step, i) => (
          <li key={step.label} className="min-w-0">
            <span aria-hidden className={`block h-1 rounded-full ${step.done ? "bg-accent" : i === steps.findIndex((s) => !s.done) ? "beat bg-warn/70" : "bg-fg/10"}`} />
            <span className={`mt-1.5 block truncate text-[11px] ${step.done ? "text-fg/80" : "text-fg/40"}`}>{step.label}</span>
          </li>
        ))}
      </ol>
      {card.heldMinor > 0 && card.spentMinor === 0 ? (
        <p className="mt-3 text-[12.5px] leading-relaxed text-fg/70">
          Airwallex authorised {money(card.heldMinor, card.currency)} and is holding it from the wallet. Tessera proves the charge against what you signed as soon as the merchant captures it.
        </p>
      ) : null}
      {card.settlements.map((s) => (
        <div key={s.transactionId} className="mt-3">
          <p className="text-[12.5px] leading-relaxed text-fg/80">
            {money(s.amountMinor, s.currency)} cleared at {s.merchant ?? "the merchant"}.{" "}
            {s.matches ? "Every check against the signed terms holds." : "It does not match what was signed; look at the checks below."}
          </p>
          <ul className="mt-2 grid gap-1">
            {s.checks.map((c) => (
              <li key={c.check} className="flex items-start gap-2 text-[12px] leading-snug">
                <Icon name={c.ok ? "check" : "close"} className={`mt-0.5 size-3.5 shrink-0 ${c.ok ? "text-accent" : "text-bad"}`} />
                <span className="min-w-0">
                  <span className="text-fg/85">{CHECK_LABEL[c.check]}</span> <span className="text-fg/50">{c.detail}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="readout mt-2 truncate text-[10.5px] text-fg/40" title={s.transactionId}>
            Airwallex {s.transactionId} · proved {when(s.at)}
          </p>
          {posting ? (
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-fg/50">
              Airwallex posts card charges to the wallet in a batch, about half an hour on the sandbox. The proof does not wait for it.
            </p>
          ) : null}
        </div>
      ))}
    </Tile>
  );
}

const when = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * One card, its whole story and what can be done with it now: sign or decline it while it waits; while it is live,
 * let the agent pay with it through Visa TAP, test a merchant charge against its controls, freeze or close it.
 */
export function CardSheet({ card, canCharge, operator, onClose }: { card: CardView | null; canCharge: boolean; operator: string; onClose: () => void }) {
  const noteId = useId();
  const amountId = useId();
  const mccId = useId();
  const [note, setNote] = useState("");
  const [amount, setAmount] = useState("");
  const [mcc, setMcc] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  useEffect(() => {
    if (!card) return;
    setNote("");
    setNotice(null);
    setAmount(String(card.amountMinor / 100));
    setMcc(card.mccs[0] ?? "");
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // Reset only when another card is opened, not on every poll of the same one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card?.id]);

  if (!card) return null;
  const name = operator.split("@")[0];
  const value = Number(amount);
  const amountOk = Number.isFinite(value) && value > 0;

  async function act(label: string, path: string, body: unknown, done: (answer: Record<string, unknown>) => string) {
    setBusy(label);
    setNotice(null);
    try {
      const answer = await api(`cards/${card!.id}/${path}`, CheckoutAnswer, { method: "POST", body });
      setNotice({ tone: "ok", text: done(answer) });
    } catch (error) {
      setNotice({ tone: "bad", text: error instanceof ApiProblem ? error.message : "That did not go through. Try again." });
    } finally {
      setBusy(null);
      cardsChanged();
    }
  }

  const checkoutLine = (a: Record<string, unknown>) => {
    const tap = a.tap as { ok?: boolean; kid?: string; reason?: string } | undefined;
    if (a.status === "APPROVED") return `Paid. Order ${String(a.orderId)}. The merchant verified the agent's Visa TAP signature (key ${String(tap?.kid ?? "").slice(0, 10)}…) before charging.`;
    if (a.status === "REJECTED") return `The merchant refused the agent: ${String(a.reason)}.`;
    return `The card declined it: ${String(a.reason)}. Airwallex applied the controls you signed.`;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/55 p-4 backdrop-blur-md" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <Tray label={`${card.merchant} Visa card`} className="thin-scroll max-h-[92dvh] w-full max-w-[760px] gap-3 overflow-y-auto bg-canvas! p-3">
        <TrayHead
          className="px-2 pt-1"
          title={`Visa card · ${card.merchant}`}
          note={`${card.purpose} · issued by Airwallex on the Visa network`}
          right={
            <button type="button" onClick={onClose} aria-label="Close" className="well flex size-8 cursor-pointer items-center justify-center rounded-full! text-fg/55 hover:text-fg">
              <Icon name="close" className="size-4" />
            </button>
          }
        />

        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <div className="flex flex-col gap-3">
            <VisaCard card={card} />
            <Tile className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-[20px]! px-4 py-3.5">
              <Fact label="Cap">{money(card.amountMinor, card.currency)}</Fact>
              <Fact label="Spent">
                {money(card.spentMinor, card.currency)}
                {card.heldMinor > 0 ? <span className="text-fg/50"> · {money(card.heldMinor, card.currency)} authorised</span> : card.charges.some(settling) ? <span className="text-fg/50"> · settling</span> : null}
              </Fact>
              <Fact label="Merchant category">
                <span title={card.mccs.join(", ")}>{card.categoryLabel}</span>
              </Fact>
              <Fact label="Valid until">{new Date(card.activeTo).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}</Fact>
              <Fact label="Uses">{card.singleUse ? "One charge" : "Several charges"}</Fact>
              <Fact label="State">{card.state.toLowerCase()}</Fact>
            </Tile>
          </div>

          <div className="flex min-w-0 flex-col gap-3">
            <Tile className="rounded-[20px]! px-4 py-3.5">
              <div className="flex items-center justify-between gap-2">
                <Kicker>Asked for by</Kicker>
                {card.byAgent ? <Chip tone="accent">agent</Chip> : <Chip>person</Chip>}
              </div>
              <p className="readout mt-1 truncate text-[12.5px]">{card.requestedBy}</p>
              <p className="mt-2 text-[12.5px] leading-relaxed text-fg/70">{card.reason}</p>
              {card.approvedBy ? (
                <p className="mt-2 text-[12px] text-fg/55">
                  Signed by <span className="readout text-fg/80">{card.approvedBy}</span>
                </p>
              ) : null}
            </Tile>

            <Purchase card={card} />

            {card.state === "PENDING" ? (
              <Tile className="grid gap-3 rounded-[20px]! px-4 py-3.5">
                <Field label="Your note, signed onto the card" htmlFor={noteId} hint={note.trim().length >= NOTE_MIN ? undefined : `${NOTE_MIN - note.trim().length} more characters`}>
                  <TextArea id={noteId} rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Approved: two Figma seats for the design team." />
                </Field>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <Btn tone="secondary" disabled={note.trim().length < NOTE_MIN} busy={busy === "decline"} onClick={() => void act("decline", "decline", { note }, () => "Declined. The card was never issued.")}>
                    Decline
                  </Btn>
                  <Btn disabled={note.trim().length < NOTE_MIN} busy={busy === "approve"} onClick={() => void act("approve", "approve", { note }, (a) => (a.state === "ACTIVE" ? "Signed and issued at Airwallex. The card is live." : a.state === "FAILED" ? "Signed, but Airwallex refused to issue it. See why below." : "Signed. Airwallex is issuing it."))}>
                    Sign and issue as {name}
                  </Btn>
                </div>
              </Tile>
            ) : null}

            {card.state === "FAILED" || card.state === "REFUSED" ? (
              <Tile className="rounded-[20px]! px-4 py-3.5">
                <Kicker>{card.state === "FAILED" ? "Airwallex refused to issue it" : "The card policy refused it"}</Kicker>
                <p className="mt-1 text-[12.5px] leading-relaxed text-bad">{card.lastError}</p>
                {card.state === "FAILED" ? (
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <span className="text-[11.5px] leading-snug text-fg/50">Your signature stands; a retry asks Airwallex again with a fresh request.</span>
                    <Btn busy={busy === "retry"} onClick={() => void act("retry", "retry", {}, (a) => (a.state === "ACTIVE" ? "Issued. The card is live." : "Airwallex still refuses it."))}>
                      Try again
                    </Btn>
                  </div>
                ) : null}
              </Tile>
            ) : null}

            {card.state === "ACTIVE" && canCharge ? (
              <Tile className="grid gap-4 rounded-[20px]! p-4">
                <div className="grid gap-3.5">
                  <Field label="Merchant category" htmlFor={mccId}>
                    <Select
                      id={mccId}
                      value={mcc}
                      onChange={setMcc}
                      minListWidth={300}
                      options={[
                        ...card.mccs.map((code) => ({ value: code, lead: code, label: mccName(code), hint: "Allowed on this card" })),
                        { value: OFF_LIST, lead: OFF_LIST, label: mccName(OFF_LIST), hint: "Not on this card: should be declined", tone: "bad" as const },
                      ]}
                    />
                  </Field>
                  <Field label={`Amount (${card.currency})`} htmlFor={amountId}>
                    <TextInput id={amountId} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} />
                  </Field>
                </div>
                <div className="grid gap-2">
                  <Btn block disabled={!amountOk} busy={busy === "checkout"} icon={<Icon name="shield" className="size-4" />} onClick={() => void act("checkout", "checkout", { amount: value }, checkoutLine)}>
                    Agent pays via Visa TAP
                  </Btn>
                  <Btn block tone="secondary" disabled={!amountOk} busy={busy === "charge"} onClick={() => void act("charge", "charge", { amount: value, merchantCategoryCode: mcc }, () => "The merchant charged the card. Its answer is in the history below.")}>
                    Test a merchant charge
                  </Btn>
                </div>
                <p className="text-[11.5px] leading-relaxed text-fg/50">
                  The agent signs the checkout with its Trusted Agent Protocol key; the merchant verifies it before charging. Airwallex applies the card's cap, category and single use either way.
                </p>
              </Tile>
            ) : null}

            {notice ? (
              <p role={notice.tone === "bad" ? "alert" : "status"} className={`well rounded-[14px]! px-4 py-2.5 text-[12.5px] leading-relaxed ${notice.tone === "bad" ? "text-bad" : "text-fg/80"}`}>
                {notice.text}
              </p>
            ) : null}

            {card.state === "ACTIVE" || card.state === "FROZEN" ? (
              <div className="flex flex-wrap justify-end gap-2">
                <Btn tone="secondary" busy={busy === "freeze"} onClick={() => void act("freeze", card.state === "ACTIVE" ? "freeze" : "unfreeze", { why: "" }, () => (card.state === "ACTIVE" ? "Frozen: every charge is declined until you unfreeze it." : "Unfrozen: the card can pay again."))}>
                  {card.state === "ACTIVE" ? "Freeze" : "Unfreeze"}
                </Btn>
                <Btn tone="ink" busy={busy === "close"} onClick={() => void act("close", "close", { why: "" }, () => "Closed at Airwallex. It can never pay again.")}>
                  Close card
                </Btn>
              </div>
            ) : null}
          </div>
        </div>

        <Tile className="rounded-[20px]! px-4 py-3">
          <Kicker>History on the ledger</Kicker>
          {card.charges.length === 0 && card.checkouts.length === 0 ? (
            <p className="mt-1.5 text-[12.5px] text-fg/50">No charges yet. Every charge and every decline Airwallex reports lands here, and each charge is followed until Airwallex posts it.</p>
          ) : (
            <ul className="mt-2 divide-y divide-fg/[0.06]">
              {[
                ...card.checkouts.map((c) => ({
                  key: `co-${c.at}`,
                  at: c.at,
                  row: (
                    <>
                      <span className="flex min-w-0 items-center gap-2">
                        <Chip tone={c.tapVerified ? "accent" : "bad"}>{c.tapVerified ? "TAP verified" : "TAP rejected"}</Chip>
                        <span className="truncate text-[12.5px]">
                          Agent checkout · {c.status.toLowerCase()}
                          {c.orderId ? ` · ${c.orderId}` : c.reason ? ` · ${c.reason}` : ""}
                        </span>
                      </span>
                      <span className="readout shrink-0 text-[11px] text-fg/45">{when(c.at)}</span>
                    </>
                  ),
                })),
                ...card.charges.map((c) => ({
                  key: c.transactionId,
                  at: c.at,
                  row: (
                    <>
                      <span className="flex min-w-0 items-center gap-2">
                        <Chip tone={c.status === "FAILED" ? "bad" : settling(c) ? "warn" : c.type === "CLEARING" ? "solid" : "neutral"}>{chargeWord(c)}</Chip>
                        <span className={`readout shrink-0 text-[12.5px] ${c.status === "FAILED" ? "text-fg/45 line-through" : ""}`}>
                          {c.type === "REFUND" ? "+" : "−"}
                          {money(Math.abs(c.amountMinor), c.currency)}
                        </span>
                        <span className="truncate text-[12px] text-fg/60">
                          {c.merchant ?? "merchant"} · {c.mcc ?? "—"}
                          {c.failureReason ? ` · ${c.failureReason}` : ""}
                        </span>
                      </span>
                      <span className="readout shrink-0 text-[11px] text-fg/45">{when(c.at)}</span>
                    </>
                  ),
                })),
              ]
                .sort((a, b) => b.at.localeCompare(a.at))
                .map((item) => (
                  <li key={item.key} className="flex items-center justify-between gap-3 py-2">
                    {item.row}
                  </li>
                ))}
            </ul>
          )}
        </Tile>
      </Tray>
    </div>
  );
}
