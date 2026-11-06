"use client";

import { useId, useRef, useState } from "react";
import { Acknowledged, api } from "@/lib/client-api";
import { ago } from "@/lib/format";
import { InboxCreatedSchema, type IncidentView } from "../../../src/server/wire";
import { Button, Frame, Label, PanelHeader, Tag } from "../ui";
import { Field, TextArea, TextInput } from "./fields";
import type { RunAction } from "./actions-panel";

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
    <Frame>
      <PanelHeader title="Supplier inbox" right={<Label>{view.inbox.length === 1 ? "1 message" : `${view.inbox.length} messages`}</Label>} />
      <div className="space-y-6 p-5">
        {view.inbox.length === 0 ? (
          <p className="hatch px-4 py-5 text-sm leading-relaxed text-muted">No messages from the supplier yet. Paste one below or upload a .eml file.</p>
        ) : (
          <ul className="divide-y divide-rule border-y border-rule">
            {view.inbox.map((message) => (
              <li key={message.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{message.from}</span>
                  <span className="block text-xs text-muted">{ago(message.receivedAt)}</span>
                </span>
                <span className="flex items-center gap-3">
                  {message.read ? <Tag tone="blue-outline">Read</Tag> : <Tag tone="muted">Unread</Tag>}
                  <Button
                    variant="quiet"
                    disabled={reader === null}
                    busy={busy === `read-${message.id}`}
                    onClick={() =>
                      run(`read-${message.id}`, async () => {
                        await api(`obligations/${id}/evidence/read`, Acknowledged, { method: "POST", body: { messageId: message.id } });
                        return {
                          tone: "ok",
                          title: `Read by ${reader}`,
                          lines: ["The recommendation was recalculated. Code checked each claim against the text first."],
                        };
                      })
                    }
                  >
                    {reader && !reader.includes("offline") ? `Read with ${reader}` : reader ? "Read (offline reader)" : "Read"}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
        {reader === null ? (
          <p className="text-xs leading-relaxed text-muted">No reader is connected to this server. Record what the supplier said by hand instead.</p>
        ) : null}

        <div className="space-y-4 border-t border-rule pt-5">
          <Label className="text-ink">Add a message</Label>
          <Field label="Paste the message, or a whole .eml" htmlFor={emailId} hint={eml ? "Looks like a raw email: the sender and subject are taken from its headers." : undefined}>
            <TextArea
              id={emailId}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={`Hi, ${view.obligation.reference} has not arrived and the deadline has passed...`}
              rows={5}
              maxLength={MAX_CHARS}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-4">
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
            <Button variant="quiet" onClick={() => fileInput.current?.click()}>
              Upload a .eml or .txt
            </Button>
            {fileError ? (
              <span role="alert" className="text-xs">
                {fileError}
              </span>
            ) : null}
          </div>
          {!eml ? (
            <Field label="From" htmlFor={fromId}>
              <TextInput id={fromId} value={from} onChange={(e) => setFrom(e.target.value)} placeholder="accounts@supplier.example" maxLength={320} />
            </Field>
          ) : null}
          <Field label="Their bank statement (optional)" htmlFor={statementId}>
            <TextArea id={statementId} value={statement} onChange={(e) => setStatement(e.target.value)} placeholder="04 Oct  AIRWALLEX PAYOUT  CR  25.00 USD" rows={3} maxLength={MAX_CHARS} />
          </Field>
          <Button
            variant="secondary"
            className="w-full"
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
                return { tone: "ok", title: "Message added to the inbox", lines: ["Nothing has read it yet. Read it from the list above when you are ready."] };
              })
            }
          >
            Add to the inbox
          </Button>
        </div>
      </div>
    </Frame>
  );
}
