"use client";

import { useState } from "react";
import { Acknowledged, api } from "@/lib/client-api";
import { ago } from "@/lib/format";
import type { IncidentView } from "../../../src/server/wire";
import { Button, Frame, Label, PanelHeader, Tag } from "../ui";
import type { RunAction } from "./actions-panel";

const KIND = { STATUS: "Status update", PROOF: "Proof of payment", CORRECTION: "Request for corrected details" } as const;

/**
 * A reply an agent drafted for the supplier. Tessera sends nothing: a person reads it, sends it from their own mail,
 * and says so here. The facts underneath were written by code from the ledger, not by the agent.
 */
export function DraftPanel({ view, busy, run }: { view: IncidentView; busy: string | null; run: RunAction }) {
  const draft = view.draft;
  const [copied, setCopied] = useState(false);
  if (!draft) return null;
  const id = view.obligation.id;

  const resolve = (resolution: "SENT" | "DISCARDED") =>
    run(`draft-${resolution}`, async () => {
      await api(`obligations/${id}/drafts/resolve`, Acknowledged, { method: "POST", body: { draftSeq: draft.seq, resolution } });
      return resolution === "SENT"
        ? { tone: "ok", title: "Recorded as sent", lines: ["The ledger now shows that you sent this reply."] }
        : { tone: "ok", title: "Draft discarded", lines: [] };
    });

  async function copy() {
    await navigator.clipboard.writeText([draft!.message, "", ...draft!.facts].join("\n")).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Frame>
      <PanelHeader title="Drafted reply to the supplier" right={<Tag tone="blue-outline">{KIND[draft.kind]}</Tag>} />
      <div className="space-y-5 p-5">
        <div className="border border-ink p-5">
          <p className="whitespace-pre-line text-[15px] leading-relaxed">{draft.message}</p>
          <div className="hatch mt-5 border-t border-rule pt-4">
            <Label>Added by Tessera from the ledger</Label>
            <ul className="mt-2 space-y-1 font-mono text-[12.5px] text-muted">
              {draft.facts.map((fact) => (
                <li key={fact}>{fact}</li>
              ))}
            </ul>
          </div>
        </div>
        <p className="text-sm leading-relaxed text-muted">
          Drafted by <span className="font-mono text-[13px] text-ink">{draft.actor}</span> {ago(draft.at)}. Tessera sends nothing: copy it, send it from your own
          mail, then say so here. The code refused any draft with account details, links, or a promise of another payment.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy to clipboard"}
          </Button>
          <Button busy={busy === "draft-SENT"} disabled={busy !== null && busy !== "draft-SENT"} onClick={() => resolve("SENT")}>
            I sent it
          </Button>
          <Button variant="quiet" busy={busy === "draft-DISCARDED"} disabled={busy !== null && busy !== "draft-DISCARDED"} onClick={() => resolve("DISCARDED")}>
            Discard
          </Button>
        </div>
      </div>
    </Frame>
  );
}
