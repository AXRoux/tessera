"use client";

import { useEffect, useId, useState } from "react";
import type { Cards } from "../../../src/server/wire";
import { Acknowledged, api, ApiProblem } from "@/lib/client-api";
import { cardsChanged, OPEN_CARD } from "@/lib/use-cards";
import { money } from "@/lib/format";
import { Field, TextArea, TextInput } from "../console/fields";
import { Icon } from "../landing/icons";
import { Btn } from "../kit/metal";
import { Kicker, Tile, Tray, TrayHead } from "../kit/widgets";
import { VisaMark } from "./visa-card";

const REASON_MIN = 12;

/**
 * Ask for a Visa virtual card for one purchase: what it is for, the one merchant it may pay, the kind of merchant, a
 * cap and why. Code checks it the moment it is asked for; if it passes, it waits for a signature (yours, next) and only
 * then is it cut at Airwallex, with exactly these terms as its controls.
 */
export function CardComposer({ open, cards, onClose }: { open: boolean; cards: Cards | null; onClose: () => void }) {
  const purposeId = useId();
  const merchantId = useId();
  const amountId = useId();
  const reasonId = useId();
  const [purpose, setPurpose] = useState("");
  const [merchant, setMerchant] = useState("");
  const [category, setCategory] = useState("software");
  const [currency, setCurrency] = useState("USD");
  const [amount, setAmount] = useState("45.00");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setRefusal(null);
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const limit = cards?.limits.find((l) => l.currency === currency) ?? null;
  const value = Number(amount);
  const amountOk = Number.isFinite(value) && value > 0 && (!limit || value * 100 <= limit.personMaxMinor);
  const ready = purpose.trim().length >= 3 && merchant.trim().length >= 2 && amountOk && reason.trim().length >= REASON_MIN;

  async function submit() {
    setBusy(true);
    setRefusal(null);
    try {
      const answer = await api("cards", Acknowledged, { method: "POST", body: { purpose, merchant, category, amount: Math.round(value * 100) / 100, currency, reason } });
      cardsChanged();
      if (answer.state === "REFUSED") {
        setRefusal(String(answer.reasons ?? "The card policy refused it."));
        return;
      }
      onClose();
      // Straight to the signature: asking and signing are separate acts, by design, even for the same person.
      window.dispatchEvent(new CustomEvent(OPEN_CARD, { detail: String(answer.id) }));
    } catch (error) {
      setRefusal(error instanceof ApiProblem ? error.message : "That did not go through. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/55 p-4 backdrop-blur-md" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <Tray label="New Visa card" className="thin-scroll max-h-[92dvh] w-full max-w-[560px] gap-3 overflow-y-auto bg-canvas! p-3">
        <TrayHead
          className="px-2 pt-1"
          title="New Visa card"
          note="A single-use virtual card, issued by Airwallex"
          right={
            <button type="button" onClick={onClose} aria-label="Close" className="well flex size-8 cursor-pointer items-center justify-center rounded-full! text-fg/55 hover:text-fg">
              <Icon name="close" className="size-4" />
            </button>
          }
        />

        <Tile className="grid gap-3 rounded-[20px]! px-4 py-3.5">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="What it is for" htmlFor={purposeId}>
              <TextInput id={purposeId} value={purpose} onChange={(e) => setPurpose(e.target.value.slice(0, 120))} placeholder="Figma, two editor seats" />
            </Field>
            <Field label="The one merchant it may pay" htmlFor={merchantId}>
              <TextInput id={merchantId} value={merchant} onChange={(e) => setMerchant(e.target.value.slice(0, 60))} placeholder="Figma" />
            </Field>
          </div>
          <div>
            <Kicker>Kind of merchant</Kicker>
            <div className="mt-1.5 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Kind of merchant">
              {(cards?.categories ?? []).map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="radio"
                  aria-checked={category === c.id}
                  onClick={() => setCategory(c.id)}
                  title={`Visa merchant categories ${c.mccs.join(", ")}`}
                  className={`h-8 cursor-pointer rounded-full px-3 text-[12px] font-medium transition-colors ${category === c.id ? "tile inverse rounded-full! text-fg" : "well rounded-full! text-fg/60 hover:text-fg"}`}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        </Tile>

        <Tile className="rounded-[20px]! px-4 py-3.5">
          <div className="flex items-start justify-between gap-3">
            <label htmlFor={amountId} className="kicker block">
              Cap: the most it may ever be charged
            </label>
            <div className="well flex rounded-full! p-0.5" role="radiogroup" aria-label="Currency">
              {(cards?.limits ?? [{ currency: "USD" }]).map((l) => (
                <button key={l.currency} type="button" role="radio" aria-checked={currency === l.currency} onClick={() => setCurrency(l.currency)} className={`h-7 cursor-pointer rounded-full px-2.5 text-[11.5px] font-medium ${currency === l.currency ? "tile rounded-full! text-fg" : "text-fg/50"}`}>
                  {l.currency}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-1.5 flex items-baseline gap-2">
            <input
              id={amountId}
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
              className="readout w-full bg-transparent text-[34px] font-medium leading-none tracking-[-0.04em] text-fg outline-none"
            />
            <VisaMark className="text-[22px] text-fg/25" />
          </div>
          <p className={`mt-1.5 text-[11.5px] ${amountOk ? "text-fg/45" : "text-bad"}`}>
            {limit
              ? `Up to ${money(limit.personMaxMinor, currency)} per card when a person asks; ${money(limit.agentMaxMinor, currency)} when an agent does.`
              : "Reading the card limits…"}
          </p>
        </Tile>

        <div className="px-1">
          <Field label="Why the business needs it" htmlFor={reasonId} hint={reason.trim().length >= REASON_MIN ? undefined : `The person who signs reads this (${REASON_MIN - reason.trim().length} more characters).`}>
            <TextArea id={reasonId} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="The design team grows by two this month and needs editor seats." />
          </Field>
        </div>

        {refusal ? (
          <p role="alert" className="well rounded-[14px]! px-4 py-2.5 text-[12.5px] leading-relaxed text-bad">
            Refused by the card policy: {refusal}
          </p>
        ) : null}

        <div className="flex items-center justify-between gap-3 px-1 pb-1">
          <span className="text-[11.5px] leading-snug text-fg/50">Checked by policy now. Issued only after a person signs it, with these terms as the card's controls.</span>
          <Btn size="md" disabled={!ready} busy={busy} onClick={() => void submit()}>
            Ask for the card
          </Btn>
        </div>
      </Tray>
    </div>
  );
}
