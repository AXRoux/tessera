"use client";

import { useEffect, useId, useState } from "react";
import { PayeeSchema, type Health, type Payee } from "../../../src/server/wire";
import { api } from "@/lib/client-api";
import { money } from "@/lib/format";
import { Field, TextArea, TextInput } from "../console/fields";
import { Icon } from "../landing/icons";
import { Btn } from "../kit/metal";
import { Kicker, Tile, Tray, TrayHead } from "../kit/widgets";

/** Mirrors WRITTEN_NOTE_MIN_CHARS on the API, so the button can say why it is waiting. */
const NOTE_MIN = 10;

/**
 * A real payout, composed by a person: the amount, a reference, and their own reason for paying, signed under their
 * name. It goes straight to the Airwallex payee the server is configured with; there is no scripted data behind it.
 * Tessera seals the instruction in the ledger before the network call, and every status after it comes from Airwallex.
 */
export function Composer({
  open,
  onClose,
  health,
  create,
  creating,
}: {
  open: boolean;
  onClose: () => void;
  health: Health | null;
  create: (payout: { amount: number; reference?: string; note: string }) => Promise<string | null>;
  creating: boolean;
}) {
  const amountId = useId();
  const referenceId = useId();
  const noteId = useId();
  const [payee, setPayee] = useState<Payee | null>(null);
  const [amount, setAmount] = useState("25.00");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    void api("payee", PayeeSchema)
      .then(setPayee)
      .catch(() => setPayee(null));
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const value = Number(amount);
  const max = payee?.maxAmount ?? 1_000;
  const amountOk = Number.isFinite(value) && value > 0 && value <= max;
  const noteOk = note.trim().length >= NOTE_MIN;
  const operator = payee?.operator ?? health?.operator ?? "operator";
  const name = operator.split("@")[0];

  async function send() {
    setError(null);
    const failed = await create({ amount: Math.round(value * 100) / 100, note: note.trim(), ...(reference.trim() ? { reference: reference.trim() } : {}) });
    if (failed) setError(failed);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/55 p-4 backdrop-blur-md" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <Tray label="New payout" className="w-full max-w-[540px] gap-3 bg-canvas! p-3">
        <TrayHead
          className="px-2 pt-1"
          title="New payout"
          note={health?.offline ? "Simulated Airwallex: no network, no money" : "Sent through the Airwallex sandbox, for real"}
          right={
            <button type="button" onClick={onClose} aria-label="Close" className="well flex size-8 cursor-pointer items-center justify-center rounded-full! text-fg/55 hover:text-fg">
              <Icon name="close" className="size-4" />
            </button>
          }
        />

        <Tile className="flex items-center justify-between gap-4 rounded-[20px]! px-4 py-3">
          <div className="min-w-0">
            <Kicker>Pays</Kicker>
            <p className="readout mt-1 truncate text-[14px] font-medium">{payee ? (payee.nickname ?? payee.beneficiaryId) : "Reading the payee from Airwallex…"}</p>
          </div>
          <div className="shrink-0 text-right">
            <Kicker>Rail</Kicker>
            <p className="readout mt-1 text-[13px]">{payee ? `${payee.method} · ${payee.currency}` : "—"}</p>
          </div>
        </Tile>

        <Tile className="rounded-[20px]! px-4 py-3.5">
          <label htmlFor={amountId} className="kicker block">
            Amount
          </label>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span className="readout text-[28px] font-medium text-fg/45">$</span>
            <input
              id={amountId}
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value.replace(/[^\d.]/g, ""))}
              className="readout w-full bg-transparent text-[34px] font-medium leading-none tracking-[-0.04em] text-fg outline-none"
            />
          </div>
          <p className={`mt-1.5 text-[11.5px] ${amountOk ? "text-fg/45" : "text-bad"}`}>{amountOk ? `Up to ${money(max * 100, "USD")} per payout on this account` : `Between $0.01 and ${money(max * 100, "USD")}`}</p>
        </Tile>

        <div className="grid gap-3 px-1">
          <Field label="Reference, as the supplier will see it" htmlFor={referenceId} hint="Leave it empty and Tessera assigns one.">
            <TextInput id={referenceId} value={reference} onChange={(event) => setReference(event.target.value.slice(0, 40))} placeholder="INV-1043" />
          </Field>
          <Field label="Why this payment is owed" htmlFor={noteId} hint={noteOk ? undefined : `Your reason is signed onto the approval (${NOTE_MIN - note.trim().length} more characters).`}>
            <TextArea id={noteId} value={note} onChange={(event) => setNote(event.target.value)} rows={2} maxLength={500} placeholder="Northwind invoice 1043, approved by finance on Monday." />
          </Field>
        </div>

        {error ? (
          <p role="alert" className="well rounded-[14px]! px-4 py-2.5 text-[12.5px] text-bad">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-between gap-3 px-1 pb-1">
          <span className="text-[11.5px] leading-snug text-fg/50">
            Signed by <span className="readout text-fg/80">{operator}</span>. Sealed in the ledger before any money moves.
          </span>
          <Btn size="md" disabled={!amountOk || !noteOk || !payee} busy={creating} onClick={() => void send()}>
            Sign and send as {name}
          </Btn>
        </div>
      </Tray>
    </div>
  );
}
