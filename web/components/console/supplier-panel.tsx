"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import { Acknowledged, api } from "@/lib/client-api";
import { ago, money, toMinor } from "@/lib/format";
import { InboxCreatedSchema, type IncidentView } from "../../../src/server/wire";

import { Check, Field, Fold, TextArea, TextInput } from "./fields";
import type { RunAction } from "./actions-panel";
import { Btn } from "../kit/metal";
import { Chip, Toggle } from "../kit/widgets";

type Recorded = NonNullable<IncidentView["evidence"]>;

/** The API refuses a message longer than this. */
const MAX_CHARS = 20_000;
/** A raw .eml carries its own From header, so the API parses the sender out of it. */
const looksLikeEml = (text: string): boolean => /^from:\s*\S/im.test(text) && /^subject:/im.test(text);
/** A hand-entered record is stamped "entered by …" in the same list where code notes its corrections of a model. */
const corrections = (r: Recorded): string[] => r.evidence.adjustments.filter((a) => !/^entered by /i.test(a));

/** How many things the supplier has told us: their messages, plus anything a person recorded from a call or chat. */
export const supplierCount = (view: IncidentView): number => view.inbox.length + (view.evidence?.source === "manual" ? 1 : 0);

/**
 * What the supplier's word does to the recommendation, one line per thing they claimed, in the policy's own terms
 * (src/commander/policy.ts): a statement only confirms receipt when a person entered it, a bank-detail change by message
 * goes to a person, instructions aimed at an assistant are ignored.
 */
function readings(r: Recorded, view: IncidentView): { tone: "good" | "bad" | "plain"; tag: string; means: string }[] {
  const e = r.evidence;
  const o = view.obligation;
  const out: { tone: "good" | "bad" | "plain"; tag: string; means: string }[] = [];
  if (e.statementCredit) {
    const shown = money(e.statementCredit.amountMinor, e.statementCredit.currency);
    const matches = e.statementCredit.currency === o.currency && e.statementCredit.amountMinor === o.amountMinor;
    if (!matches) out.push({ tone: "bad", tag: `Statement shows ${shown}`, means: `Their statement shows ${shown}, not the ${money(o.amountMinor, o.currency)} owed, so it confirms nothing.` });
    else if (r.source === "manual") out.push({ tone: "good", tag: `Statement shows ${shown}`, means: "Their own statement shows our payment, which confirms they received it." });
    else out.push({ tone: "plain", tag: `Statement shows ${shown}`, means: "A statement that arrives by message can be forged, so it does not confirm receipt. Enter what you see on it yourself if it does." });
  }
  if (e.claimsNonReceipt) {
    out.push({ tone: "bad", tag: "Says it never arrived", means: "They say nothing arrived. If Airwallex shows it paid, Tessera answers with proof of payment; a claim never pays twice." });
  }
  if (e.requestsDetailChange) {
    out.push({ tone: "bad", tag: "Asks to change bank details", means: "A change of bank details by message is the classic fraud. It goes to a person, who confirms on a number already on file." });
  }
  if (e.containsEmbeddedInstructions) {
    out.push({ tone: "bad", tag: "Instructions for an assistant", means: "It carries instructions aimed at an assistant. They were ignored." });
  }
  if (!e.referencesObligation) {
    out.push({ tone: "plain", tag: `Does not cite ${o.reference}`, means: `It never names ${o.reference}, so its claims are not matched to this invoice.` });
  }
  return out;
}

const TAG_TONE = { good: "accent", bad: "bad", plain: "neutral" } as const;

function Said({ record, view, reader }: { record: Recorded; view: IncidentView; reader: string | null }) {
  const lines = readings(record, view);
  const fixed = corrections(record);
  return (
    <div className="tile rounded-[20px]! p-4">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <Chip tone={record.source === "model" ? "accent" : "neutral"}>{record.source === "model" ? `Read from their message by ${reader ?? "the reader"}` : "From a call or chat, recorded by hand"}</Chip>
        <span suppressHydrationWarning className="text-[11.5px] text-fg/45">
          {record.enteredBy.replace(/^agent:/, "")}, {ago(record.at)}
        </span>
      </div>
      <blockquote className="mt-3 border-l-2 border-fg/15 pl-3 text-[14px] leading-relaxed text-fg">{record.evidence.summary}</blockquote>
      {lines.length === 0 ? (
        <p className="mt-3 text-[12.5px] leading-relaxed text-fg/55">No claims that change anything: no missing money, no new bank details.</p>
      ) : (
        <ul className="mt-3.5 space-y-2.5 border-t border-fg/[0.06] pt-3">
          {lines.map((line) => (
            <li key={line.tag} className="flex flex-col items-start gap-1.5">
              <Chip tone={TAG_TONE[line.tone]}>{line.tag}</Chip>
              <p className="text-[12.5px] leading-relaxed text-fg/65">{line.means}</p>
            </li>
          ))}
        </ul>
      )}
      {record.source === "model" && fixed.length > 0 ? (
        <div className="well mt-3 rounded-[14px]! px-3 py-2.5">
          <p className="text-[11.5px] font-medium text-fg">Where code overruled the reader</p>
          <ul className="mt-1 space-y-0.5">
            {fixed.map((a) => (
              <li key={a} className="text-[12px] leading-relaxed text-fg/65">
                {a}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2.5">
      <div className="flex items-center justify-between gap-3">
        <span className="kicker">{title}</span>
        {aside}
      </div>
      {children}
    </section>
  );
}

/**
 * Everything the supplier has said about this invoice, in one place: what Tessera took from it and what that does to
 * the recommendation; their messages, each read once by the reader; and one way to add more, either their email as it
 * arrived or a call written down by hand.
 */
export function SupplierPanel({ view, reader, busy, run }: { view: IncidentView; reader: string | null; busy: string | null; run: RunAction }) {
  const ids = { from: useId(), email: useId(), statement: useId(), flags: useId(), credit: useId(), summary: useId() };
  const fileInput = useRef<HTMLInputElement>(null);
  const [how, setHow] = useState<"email" | "call">(reader === null ? "call" : "email");
  // Email
  const [from, setFrom] = useState("");
  const [email, setEmail] = useState("");
  const [statement, setStatement] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  // Call or chat
  const [flags, setFlags] = useState({ claimsNonReceipt: false, requestsDetailChange: false, referencesObligation: true, containsEmbeddedInstructions: false });
  const [credit, setCredit] = useState("");
  const [summary, setSummary] = useState("");

  const id = view.obligation.id;
  const currency = view.obligation.currency;
  const eml = looksLikeEml(email);
  const canAdd = email.trim().length > 0 && email.length <= MAX_CHARS && (eml || from.trim().length > 0);
  const readerName = reader && !reader.includes("offline") ? reader : null;

  async function load(file: File) {
    setFileError(null);
    if (file.size > MAX_CHARS * 4) return setFileError(`That file is too large. Messages are limited to ${MAX_CHARS.toLocaleString()} characters.`);
    const text = await file.text();
    if (text.length > MAX_CHARS) return setFileError(`That message is ${text.length.toLocaleString()} characters; the limit is ${MAX_CHARS.toLocaleString()}.`);
    setEmail(text);
  }

  const read = (messageId: string) =>
    run(`read-${messageId}`, async () => {
      await api(`obligations/${id}/evidence/read`, Acknowledged, { method: "POST", body: { messageId } });
      return { tone: "ok", title: `Read by ${reader}`, lines: ["Code checked every claim against the text before it counted, and the recommendation was weighed again."] };
    });

  return (
    <div className="space-y-5">
      <Section title="What the supplier says">
        {view.evidence ? (
          <Said record={view.evidence} view={view} reader={reader} />
        ) : (
          <p className="well rounded-[18px]! px-4 py-3.5 text-[12.5px] leading-relaxed text-fg/60">
            {view.inbox.length > 0
              ? "Their message has not been read yet. Until it is, Tessera decides from the ledger and the bank alone."
              : "Nothing from the supplier yet. Tessera decides from the ledger and the bank alone, which is all a routine payment needs."}
          </p>
        )}
      </Section>

      {view.inbox.length > 0 ? (
        <Section title="Their messages" aside={<span className="tnum text-[11.5px] text-fg/45">{view.inbox.length}</span>}>
          <ul className="tile divide-y divide-fg/[0.06] rounded-[20px]!">
            {view.inbox.map((message) => (
              <li key={message.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <span className="min-w-0">
                  <span className="block truncate text-[13px]">{message.from}</span>
                  <span suppressHydrationWarning className="block text-[11.5px] text-fg/45">
                    arrived {ago(message.receivedAt)}
                  </span>
                </span>
                {message.read ? (
                  <Chip tone="accent">Read</Chip>
                ) : (
                  <Btn tone="secondary" disabled={reader === null} busy={busy === `read-${message.id}`} onClick={() => read(message.id)}>
                    {readerName ? `Read with ${readerName}` : "Read it"}
                  </Btn>
                )}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Fold title="Add what the supplier said" sub="Their email as it arrived, or a call written down">
        <div className="space-y-4">
          <Toggle
            label="How they got in touch"
            value={how}
            onChange={setHow}
            className="w-fit"
            options={[
              { id: "email", label: "They wrote" },
              { id: "call", label: "A call or chat" },
            ]}
          />

          {how === "email" ? (
            <div className="space-y-3">
              <p className="text-[12px] leading-relaxed text-fg/55">
                Paste their email, or upload the .eml exactly as it arrived. {readerName ? `${readerName} reads it` : "The reader reads it"}; code then checks every claim against the text before it counts.
              </p>
              <Field label="Their message" htmlFor={ids.email} hint={eml ? "A raw email: the sender and subject come from its headers." : undefined}>
                <TextArea id={ids.email} value={email} onChange={(e) => setEmail(e.target.value)} placeholder={`Hello, ${view.obligation.reference} still hasn't reached us…`} rows={4} maxLength={MAX_CHARS} />
              </Field>
              <div className="flex flex-wrap items-center gap-3">
                <input
                  ref={fileInput}
                  type="file"
                  accept=".eml,.txt,message/rfc822,text/plain"
                  className="sr-only"
                  aria-label="Upload a .eml or text file"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void load(file);
                    e.target.value = "";
                  }}
                />
                <button type="button" onClick={() => fileInput.current?.click()} className="cursor-pointer text-[12.5px] text-accent underline decoration-fg/20 underline-offset-4 hover:text-fg">
                  Upload a .eml or .txt
                </button>
                {fileError ? (
                  <span role="alert" className="text-[12px] text-bad">
                    {fileError}
                  </span>
                ) : null}
              </div>
              {!eml ? (
                <Field label="From" htmlFor={ids.from}>
                  <TextInput id={ids.from} value={from} onChange={(e) => setFrom(e.target.value)} placeholder="accounts@supplier.example" maxLength={320} />
                </Field>
              ) : null}
              <Field label="Their bank statement, if they sent one" htmlFor={ids.statement}>
                <TextArea id={ids.statement} value={statement} onChange={(e) => setStatement(e.target.value)} placeholder="13 Nov  AIRWALLEX PAYOUT  CR  25.00 USD" rows={2} maxLength={MAX_CHARS} />
              </Field>
              <Btn
                block
                disabled={!canAdd}
                busy={busy === "inbox"}
                onClick={() =>
                  run("inbox", async () => {
                    const created = await api(`obligations/${id}/inbox`, InboxCreatedSchema, {
                      method: "POST",
                      body: { ...(from.trim() ? { from: from.trim() } : {}), email, ...(statement.trim() ? { statementText: statement.trim() } : {}) },
                    });
                    setEmail("");
                    setStatement("");
                    setFrom("");
                    if (reader === null) return { tone: "ok", title: "Message added", lines: ["No reader is connected, so record what it says as a call or chat."] };
                    // One step: what was pasted is what gets read, by its stored id.
                    await api(`obligations/${id}/evidence/read`, Acknowledged, { method: "POST", body: { messageId: created.id } });
                    return { tone: "ok", title: `Added and read by ${reader}`, lines: ["Code checked every claim against the text before it counted, and the recommendation was weighed again."] };
                  })
                }
              >
                {reader === null ? "Add their message" : `Add it and let ${readerName ?? "the reader"} read it`}
              </Btn>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-[12px] leading-relaxed text-fg/55">Write down what they told you. It is recorded under your name, and it counts as their word.</p>
              <Field label="What they said, in one line" htmlFor={ids.summary}>
                <TextInput id={ids.summary} value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={400} placeholder="Their statement shows our payment landed on the 13th" />
              </Field>
              <fieldset>
                <legend className="mb-1 text-[12px] font-medium text-fg/70">Did they…</legend>
                <Check id={`${ids.flags}-c`} label={`mention ${view.obligation.reference}`} checked={flags.referencesObligation} onChange={(v) => setFlags({ ...flags, referencesObligation: v })} />
                <Check id={`${ids.flags}-a`} label="say the money never arrived" checked={flags.claimsNonReceipt} onChange={(v) => setFlags({ ...flags, claimsNonReceipt: v })} />
                <Check id={`${ids.flags}-b`} label="ask to change their bank details" checked={flags.requestsDetailChange} onChange={(v) => setFlags({ ...flags, requestsDetailChange: v })} />
                <Check id={`${ids.flags}-d`} label="try to give an assistant instructions" checked={flags.containsEmbeddedInstructions} onChange={(v) => setFlags({ ...flags, containsEmbeddedInstructions: v })} />
              </fieldset>
              <Field label={`Our payment on their statement (${currency})`} htmlFor={ids.credit} hint="Only if you saw it yourself. Leave it empty otherwise.">
                <TextInput id={ids.credit} inputMode="decimal" value={credit} onChange={(e) => setCredit(e.target.value)} placeholder={(view.obligation.amountMinor / 100).toFixed(2)} />
              </Field>
              <Btn
                block
                disabled={summary.trim().length === 0}
                busy={busy === "manual"}
                onClick={() =>
                  run("manual", async () => {
                    const parsed = Number(credit);
                    const creditMinor = credit.trim() === "" || !Number.isFinite(parsed) || parsed <= 0 ? null : toMinor(parsed, currency);
                    await api(`obligations/${id}/evidence`, Acknowledged, { method: "POST", body: { ...flags, statementCreditMinor: creditMinor, summary: summary.trim() } });
                    setSummary("");
                    setCredit("");
                    return { tone: "ok", title: "Recorded", lines: ["The recommendation was weighed again with it."] };
                  })
                }
              >
                Record what they said
              </Btn>
            </div>
          )}
        </div>
      </Fold>
    </div>
  );
}
