"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useState } from "react";
import {
  RequestListSchema,
  RequestOpenedSchema,
  SupplierRequestSchema,
  SuppliersSchema,
  type Health,
  type SupplierCard,
  type SupplierRequestView,
  type Suppliers,
} from "../../../src/server/wire";
import { api, ApiProblem } from "@/lib/client-api";
import { ago, money } from "@/lib/format";
import { Field, TextArea } from "../console/fields";
import { Icon } from "../landing/icons";
import { Btn, LinkBtn } from "../kit/metal";
import { Chip, Kicker, Tile, Tray, TrayHead, type ChipTone } from "../kit/widgets";
import { Workspace } from "../shell";
import { SupplierMark } from "./supplier-mark";

const NOTE_MIN = 10;

const STATUS: Record<SupplierRequestView["status"], { label: string; tone: ChipTone; pulse: boolean }> = {
  RECEIVED: { label: "To approve", tone: "accent", pulse: true },
  HELD: { label: "On hold", tone: "bad", pulse: false },
  DUPLICATE: { label: "Filed with original", tone: "neutral", pulse: false },
  OPENED: { label: "Approved", tone: "solid", pulse: false },
  DECLINED: { label: "Declined", tone: "neutral", pulse: false },
};

/** "Due 21 Nov", and how soon. */
function dueLine(days: number): { text: string; soon: boolean } {
  const date = new Date(Date.now() + days * 86_400_000).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return { text: days <= 1 ? `Due tomorrow, ${date}` : `Due ${date}, in ${days} days`, soon: days <= 2 };
}

/** Requests, kept current: a story played on an invoice can file a new one (a supplier sending its invoice again). */
function useRequests(initial: SupplierRequestView[]) {
  const [items, setItems] = useState(initial);
  const reload = () =>
    api("requests", RequestListSchema)
      .then((list) => setItems(list.items))
      .catch(() => undefined);
  useEffect(() => {
    const timer = setInterval(() => !document.hidden && void reload(), 4000);
    return () => clearInterval(timer);
  }, []);
  return { items, setItems, reload };
}

function problemText(error: unknown): string {
  if (error instanceof ApiProblem) return (error.problem.reasons ?? [error.problem.message]).join(" ");
  return error instanceof Error ? error.message : "Something unexpected happened.";
}

function SupplierTile({ supplier, rehearsal, busy, onSend }: { supplier: SupplierCard; rehearsal: boolean; busy: boolean; onSend: () => void }) {
  const due = dueLine(supplier.dueInDays);
  return (
    <Tile as="li" className="flex flex-col gap-2.5 rounded-[22px]! p-3.5">
      <div className="flex items-start gap-3">
        <SupplierMark supplier={supplier} size={44} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14.5px] font-semibold tracking-[-0.01em]">{supplier.name}</p>
          <p className="truncate text-[12px] text-fg/50">{supplier.bills}</p>
        </div>
      </div>
      <div className="well flex items-baseline justify-between gap-2 rounded-[14px]! px-3 py-2">
        <span className="readout truncate text-[12px] text-fg/60">{supplier.nextReference}</span>
        <span className="readout text-[15px] font-medium tracking-[-0.02em]">{money(supplier.amountMinor, supplier.currency)}</span>
      </div>
      <div>
        <Chip tone={due.soon ? "warn" : "neutral"}>{due.text}</Chip>
      </div>
      {rehearsal ? (
        <Btn tone="secondary" block busy={busy} onClick={onSend} icon={<Icon name="mail" className="size-4" />}>
          Review invoice
        </Btn>
      ) : null}
    </Tile>
  );
}

function RequestRow({ request, on, onPick }: { request: SupplierRequestView; on: boolean; onPick: () => void }) {
  const status = STATUS[request.status];
  return (
    <li role="option" aria-selected={on}>
      <button type="button" onClick={onPick} className="block w-full cursor-pointer text-left">
        <Tile className={`rounded-[20px]! px-3.5 py-3 transition-shadow ${on ? "ring-2 ring-accent" : "hover:ring-1 hover:ring-fg/15"}`}>
          <span className="flex items-center gap-3">
            <SupplierMark supplier={request.supplier} size={34} />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[13px] font-semibold">{request.supplier.name}</span>
                <span className="readout shrink-0 text-[12.5px] font-medium">{money(request.amountMinor, request.currency)}</span>
              </span>
              <span className="block truncate text-[12px] text-fg/55">{request.subject}</span>
            </span>
          </span>
          <span className="mt-2.5 flex items-center justify-between gap-2">
            <Chip tone={status.tone} pulse={status.pulse}>
              {status.label}
            </Chip>
            <span suppressHydrationWarning className="readout text-[10.5px] text-fg/40">
              {request.reference} · {ago(request.receivedAt)}
            </span>
          </span>
        </Tile>
      </button>
    </li>
  );
}

/** The email as it arrived: the untrusted part, shown as text, with the invoice lines from the vendor's own record. */
function Email({ request, supplier }: { request: SupplierRequestView; supplier: SupplierCard | undefined }) {
  return (
    <Tile className="rounded-[22px]! p-4">
      <div className="flex items-start gap-3">
        <SupplierMark supplier={request.supplier} size={38} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-semibold">{request.subject}</p>
          <p className="truncate text-[12px] text-fg/55">
            From <span className={`readout ${request.checks.find((c) => c.id === "sender")?.ok === false ? "text-bad" : "text-fg/80"}`}>{request.sender}</span> to ap@acme.example
          </p>
        </div>
        <span suppressHydrationWarning className="shrink-0 text-[11px] text-fg/40">
          {ago(request.receivedAt)}
        </span>
      </div>
      <p className="mt-3.5 whitespace-pre-line border-t border-fg/[0.06] pt-3.5 text-[13px] leading-relaxed text-fg/85">{request.body}</p>
      {supplier && request.status !== "HELD" && request.verdict !== "HELD" ? (
        <div className="well mt-3.5 rounded-[16px]! px-3.5 py-3">
          <div className="flex items-center justify-between">
            <Kicker>Invoice {request.reference}</Kicker>
            <span className="text-[11px] text-fg/45">{supplier.legalName}</span>
          </div>
          <ul className="mt-2 space-y-1.5">
            {supplier.lines.map((line) => (
              <li key={line.description} className="flex items-baseline justify-between gap-3 text-[12.5px]">
                <span className="min-w-0 truncate">
                  {line.description} <span className="text-fg/45">· {line.detail}</span>
                </span>
                <span className="readout shrink-0">{money(line.amountMinor, request.currency)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-baseline justify-between border-t border-fg/[0.08] pt-2 text-[13px] font-semibold">
            <span>Total</span>
            <span className="readout">{money(request.amountMinor, request.currency)}</span>
          </div>
        </div>
      ) : null}
    </Tile>
  );
}

function Checks({ request }: { request: SupplierRequestView }) {
  return (
    <section className="space-y-2.5">
      <div className="flex items-center justify-between">
        <span className="kicker">Verified on receipt</span>
        <span className="readout text-[11px] text-fg/45">
          {request.checks.filter((c) => c.ok).length}/{request.checks.length}
        </span>
      </div>
      <ul className="tile divide-y divide-fg/[0.06] rounded-[20px]!">
        {request.checks.map((check) => (
          <li key={check.id} className="flex gap-3 px-4 py-2.5">
            <span aria-hidden className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full ${check.ok ? "bg-accent/15 text-accent" : "bg-bad/15 text-bad"}`}>
              {check.ok ? <Icon name="check" className="size-3" /> : <Icon name="close" className="size-3" />}
            </span>
            <span className="min-w-0">
              <span className="block text-[12.5px] font-medium">{check.label}</span>
              <span className="block text-[11.5px] leading-snug text-fg/55">{check.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Decide({ request, operator, onDone }: { request: SupplierRequestView; operator: string; onDone: (next: SupplierRequestView | null, openedId?: string) => void }) {
  const noteId = useId();
  const held = request.status === "HELD";
  const [note, setNote] = useState(
    held
      ? `Not from ${request.supplier.name}'s billing domain, and the bank details differ from the vendor record. Declined and flagged to security.`
      : `${request.supplier.name} invoice ${request.reference}, matched to the vendor record.`,
  );
  const [busy, setBusy] = useState<"approve" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const noteOk = note.trim().length >= NOTE_MIN;

  async function act(kind: "approve" | "decline") {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "approve") {
        const opened = await api(`requests/${request.id}/approve`, RequestOpenedSchema, { method: "POST", body: { note: note.trim() } });
        onDone(null, opened.obligationId);
      } else {
        onDone(await api(`requests/${request.id}/decline`, SupplierRequestSchema, { method: "POST", body: { note: note.trim() } }));
      }
    } catch (e) {
      setError(problemText(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <Field label={held ? "Why you are declining it" : "Your reason, signed onto the approval"} htmlFor={noteId} hint={noteOk ? undefined : `${NOTE_MIN - note.trim().length} more characters.`}>
        <TextArea id={noteId} value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} />
      </Field>
      {error ? (
        <p role="alert" className="well rounded-[14px]! px-4 py-2.5 text-[12.5px] text-bad">
          {error}
        </p>
      ) : null}
      {held ? (
        <Btn block disabled={!noteOk} busy={busy === "decline"} onClick={() => void act("decline")}>
          Decline it
        </Btn>
      ) : (
        <>
          <Btn block size="md" disabled={!noteOk} busy={busy === "approve"} onClick={() => void act("approve")}>
            Approve and pay {money(request.amountMinor, request.currency)}
          </Btn>
          <div className="flex items-center justify-between gap-3 px-1">
            <span className="text-[11.5px] leading-snug text-fg/50">
              Signed by <span className="readout text-fg/80">{operator}</span>. Pays {request.supplier.legalName} at the account on file.
            </span>
            <button type="button" disabled={!noteOk || busy !== null} onClick={() => void act("decline")} className="shrink-0 cursor-pointer text-[12px] text-fg/55 hover:text-bad disabled:cursor-default disabled:opacity-50">
              Decline
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Payables: suppliers waiting on payment. Left, the vendors with an invoice due; middle, every invoice as it arrived;
 * right, the selected one: the email, what was verified on receipt, and the decision only a person makes. (The invoices
 * are illustrative; the companies' names and marks belong to them.)
 */
export function RequestsRoom({ health, initialSuppliers, initialRequests }: { health: Health | null; initialSuppliers: Suppliers | null; initialRequests: SupplierRequestView[] }) {
  const router = useRouter();
  const [suppliers, setSuppliers] = useState(initialSuppliers);
  const { items, setItems, reload } = useRequests(initialRequests);
  const [pick, setPick] = useState<string | null>(initialRequests[0]?.id ?? null);
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = items.find((r) => r.id === pick) ?? items[0] ?? null;
  const byId = useMemo(() => new Map((suppliers?.suppliers ?? []).map((s) => [s.id, s])), [suppliers]);
  const rehearsal = suppliers?.rehearsal ?? false;
  const operator = health?.operator ?? "operator";
  const count = (status: SupplierRequestView["status"]) => items.filter((r) => r.status === status).length;

  async function send(supplierId: string) {
    setSending(supplierId);
    setError(null);
    try {
      const request = await api("requests", SupplierRequestSchema, { method: "POST", body: { supplierId } });
      setItems((list) => [request, ...list.filter((r) => r.id !== request.id)]);
      setPick(request.id);
      setSuppliers(await api("suppliers", SuppliersSchema));
    } catch (e) {
      setError(problemText(e));
    } finally {
      setSending(null);
    }
  }

  return (
    <Workspace>
      <div className="flex shrink-0 flex-wrap items-end justify-between gap-4 px-1">
        <div className="min-w-0">
          <Kicker>Payables</Kicker>
          <h1 className="mt-2 text-[clamp(22px,1.9vw,30px)] font-semibold leading-[1.1] tracking-[-0.04em]">Suppliers waiting on payment.</h1>
          <p className="mt-1.5 max-w-[640px] text-[13px] leading-snug text-fg/55">
            Invoices due from the vendors you pay. Review one and approve it; Tessera pays the account on file and stays with the transfer until it lands.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {(["RECEIVED", "HELD", "OPENED"] as const).map((s) => (
            <Tile key={s} className="flex items-center gap-2.5 rounded-[18px]! px-4 py-2.5">
              <span className="readout text-[20px] font-medium">{count(s)}</span>
              <span className="text-[12px] leading-tight text-fg/55">{STATUS[s].label}</span>
            </Tile>
          ))}
        </div>
      </div>

      <div className="grid min-h-0 gap-4 xl:flex-1 xl:grid-cols-[minmax(0,1.2fr)_minmax(300px,0.85fr)_minmax(380px,1fr)]">
        <Tray label="Awaiting payment" className="min-h-[520px] gap-3 p-3 xl:min-h-0">
          <TrayHead
            className="px-2 pt-1"
            n={1}
            title="Awaiting payment"
            note={rehearsal ? (health?.offline ? "Vendors with an invoice due · simulated Airwallex" : "Vendors with an invoice due · Airwallex sandbox") : "Vendors on file"}
          />
          {error ? (
            <p role="alert" className="well mx-1 shrink-0 rounded-[14px]! px-4 py-2.5 text-[12.5px] text-bad">
              {error}
            </p>
          ) : null}
          <ul className="thin-scroll grid min-h-0 flex-1 auto-rows-max grid-cols-1 gap-3 overflow-y-auto p-1 sm:grid-cols-2">
            {(suppliers?.suppliers ?? []).map((s) => (
              <SupplierTile key={s.id} supplier={s} rehearsal={rehearsal} busy={sending === s.id} onSend={() => void send(s.id)} />
            ))}
          </ul>
        </Tray>

        <Tray label="Received" className="min-h-[420px] gap-3 p-3 xl:min-h-0">
          <TrayHead className="px-2 pt-1" n={2} title="Received" note="Newest first" />
          {items.length === 0 ? (
            <div className="well flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-[24px]! px-6 text-center">
              <span className="flex size-14 items-center justify-center rounded-full bg-fg/[0.06] text-fg/60">
                <Icon name="inbox" className="size-6" />
              </span>
              <p className="text-[14px] font-semibold">Nothing received yet</p>
              <p className="max-w-[240px] text-[12px] leading-relaxed text-fg/50">{rehearsal ? "Review an invoice on the left and it lands here." : "Supplier invoices land here as they arrive."}</p>
            </div>
          ) : (
            <ul className="thin-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-1" role="listbox" aria-label="Invoices received">
              {items.map((r) => (
                <RequestRow key={r.id} request={r} on={r.id === current?.id} onPick={() => setPick(r.id)} />
              ))}
            </ul>
          )}
        </Tray>

        <Tray label="Invoice" className="min-h-[620px] gap-3 p-3 xl:min-h-0">
          <TrayHead
            className="px-2 pt-1"
            n={3}
            title="Invoice"
            note={current ? `${current.supplier.name} · ${current.reference}` : "Nothing selected"}
            right={current ? <Chip tone={STATUS[current.status].tone} pulse={STATUS[current.status].pulse}>{STATUS[current.status].label}</Chip> : null}
          />
          <div className="thin-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-1">
            {current ? (
              <>
                <Email request={current} supplier={byId.get(current.supplier.id)} />
                <Checks request={current} />
                <div className={`well rounded-[18px]! px-4 py-3 text-[12.5px] leading-relaxed ${current.verdict === "HELD" ? "text-bad" : "text-fg/75"}`}>{current.summary}</div>
                {current.status === "RECEIVED" || current.status === "HELD" ? (
                  <Decide
                    key={current.id}
                    request={current}
                    operator={operator}
                    onDone={(next, openedId) => {
                      if (openedId) {
                        router.push(`/incidents/${openedId}`);
                        return;
                      }
                      if (next) setItems((list) => list.map((r) => (r.id === next.id ? next : r)));
                      void reload();
                    }}
                  />
                ) : null}
                {(current.status === "OPENED" || current.status === "DUPLICATE") && current.obligationId ? (
                  <LinkBtn block href={`/incidents/${current.obligationId}`}>
                    {current.status === "OPENED" ? `Track ${current.reference}` : `Open the original`}
                  </LinkBtn>
                ) : null}
                {current.decidedBy ? (
                  <p className="px-1 text-[11.5px] leading-snug text-fg/50">
                    {current.status === "DECLINED" ? "Declined" : "Approved"} by <span className="readout text-fg/75">{current.decidedBy}</span>
                    {current.note ? `: “${current.note}”` : ""}
                  </p>
                ) : null}
              </>
            ) : (
              <Tile className="flex flex-1 items-center justify-center rounded-[24px]! text-[13px] text-fg/45">Select an invoice.</Tile>
            )}
          </div>
        </Tray>
      </div>
    </Workspace>
  );
}
