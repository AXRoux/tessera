"use client";

import { useId, useRef, useState } from "react";
import { Acknowledged, api } from "@/lib/client-api";
import { ago } from "@/lib/format";
import { InboxCreatedSchema, type IncidentView } from "../../../src/server/wire";

import { Field, Fold, TextArea, TextInput } from "./fields";
import type { RunAction } from "./actions-panel";
import { Btn } from "../kit/metal";
import { Chip } from "../kit/widgets";

/** The API refuses a message longer than this. */
const MAX_CHARS = 20_000;
/** A raw .eml carries its own From header, so the API parses the sender out of it. */
const looksLikeEml = (text: string): boolean => /^from:\s*\S/im.test(text) && /^subject:/im.test(text);

/**
 * Supplier messages land here first. Only a fingerprint goes into the ledger; the reader (the configured model, or offline the
 * scripted keyword reader) reads a stored message by its id, so what was read is exactly what arrived.
 */
export function InboxPanel({ view, reader, busy, run }: { view: IncidentView; reader: string | null; busy: string | null; run: RunAction }) {
  const fromId = useId();
  const emailId = useId();
  const statementId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [from, setFrom] = useState("");
  const [email, setEmail] = useState("");
  const [statement, setStatement] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);

  const id = view.obligation.id;
  const eml = looksLikeEml(email);
  const canAdd = email.trim().length > 0 && email.length <= MAX_CHARS && (eml || from.trim().length > 0);

  async function load(file: File) {
    setFileError(null);
    if (file.size > MAX_CHARS * 4) {
      setFileError(`That file is too large. Messages are limited to ${MAX_CHARS.toLocaleString()} characters.`);
      return;
    }
    const text = await file.text();
    if (text.length > MAX_CHARS) {
      setFileError(`That message is ${text.length.toLocaleString()} characters; the limit is ${MAX_CHARS.toLocaleString()}.`);
      return;
    }
    setEmail(text);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="kicker">Inbox</span>
        <span className="tnum text-[11.5px] text-fg/45">{view.inbox.length === 1 ? "1 message" : `${view.inbox.length} messages`}</span>
      </div>
      {view.inbox.length === 0 ? (
        <p className="well rounded-[18px]! px-4 py-4 text-[12.5px] leading-relaxed text-fg/55">
          The supplier has not written in yet. Paste their message below, or drop in the .eml exactly as it arrived.
        </p>
      ) : (
        <ul className="tile divide-y divide-fg/[0.06] rounded-[20px]!">
          {view.inbox.map((message) => (
            <li key={message.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <span className="min-w-0">
                <span className="block truncate text-[13px]">{message.from}</span>
                <span suppressHydrationWarning className="block text-[11.5px] text-fg/45">
                  arrived {ago(message.receivedAt)}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {message.read ? <Chip tone="accent">Read</Chip> : <Chip tone="neutral">Unread</Chip>}
                <Btn
                  tone="secondary"
                  disabled={reader === null}
                  busy={busy === `read-${message.id}`}
                  onClick={() =>
                    run(`read-${message.id}`, async () => {
                      await api(`obligations/${id}/evidence/read`, Acknowledged, { method: "POST", body: { messageId: message.id } });
                      return {
                        tone: "ok",
                        title: `Read by ${reader}`,
                        lines: ["The recommendation has been weighed again. Code checked every claim against the text before it counted."],
                      };
                    })
                  }
                >
                  {reader && !reader.includes("offline") ? `Read with ${reader}` : "Read it"}
                </Btn>
              </span>
            </li>
          ))}
        </ul>
      )}
      {reader === null ? <p className="text-[12px] leading-relaxed text-fg/50">No reader is connected to this server. Record what the supplier said by hand instead.</p> : null}

      <Fold title="Add a message" sub="Paste it, or upload the .eml as it arrived">
        <div className="space-y-3">
          <Field label="The message" htmlFor={emailId} hint={eml ? "This looks like a raw email: the sender and subject come from its headers." : undefined}>
            <TextArea
              id={emailId}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={`Hello — ${view.obligation.reference} still hasn't reached us and the deadline has passed…`}
              rows={4}
              maxLength={MAX_CHARS}
            />
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
            <Field label="From" htmlFor={fromId}>
              <TextInput id={fromId} value={from} onChange={(e) => setFrom(e.target.value)} placeholder="accounts@supplier.example" maxLength={320} />
            </Field>
          ) : null}
          <Field label="Their bank statement, if they sent one" htmlFor={statementId}>
            <TextArea id={statementId} value={statement} onChange={(e) => setStatement(e.target.value)} placeholder="04 Oct  AIRWALLEX PAYOUT  CR  25.00 USD" rows={2} maxLength={MAX_CHARS} />
          </Field>
          <Btn
            tone="secondary"
            block
            disabled={!canAdd}
            busy={busy === "inbox"}
            onClick={() =>
              run("inbox", async () => {
                await api(`obligations/${id}/inbox`, InboxCreatedSchema, {
                  method: "POST",
                  body: { ...(from.trim() ? { from: from.trim() } : {}), email, ...(statement.trim() ? { statementText: statement.trim() } : {}) },
                });
                setEmail("");
                setStatement("");
                setFrom("");
                return { tone: "ok", title: "Added to the inbox", lines: ["Nothing has read it yet. Read it from the inbox when you are ready."] };
              })
            }
          >
            Add to the inbox
          </Btn>
        </div>
      </Fold>
    </div>
  );
}
