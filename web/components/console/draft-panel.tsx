"use client";

import { useState } from "react";
import { Acknowledged, api } from "@/lib/client-api";
import { actorLabel } from "@/lib/agent-verdict";
import { ago } from "@/lib/format";
import type { IncidentView } from "../../../src/server/wire";

import type { RunAction } from "./actions-panel";
import { Btn } from "../kit/metal";

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
        : { tone: "ok", title: "Draft set aside", lines: [] };
    });

  async function copy() {
    await navigator.clipboard.writeText([draft!.message, "", ...draft!.facts].join("\n")).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="tile rounded-[22px]! p-4 ring-1 ring-accent/30">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-[13.5px] font-semibold"><span aria-hidden className="size-2 rounded-full bg-accent" />A reply, drafted for you</span>
        <span className="well rounded-full! px-2.5 py-1 text-[11px] font-medium text-accent">{KIND[draft.kind]}</span>
      </div>
      <p className="well mt-3 whitespace-pre-line rounded-[16px]! px-4 py-3 text-[13px] leading-relaxed">{draft.message}</p>
      <div className="mt-2.5">
        <p className="text-[11px] text-fg/45">Added by Tessera from the ledger, not by the agent</p>
        <ul className="mt-1 space-y-0.5 readout text-[11.5px] text-fg/65">
          {draft.facts.map((fact) => (
            <li key={fact}>{fact}</li>
          ))}
        </ul>
      </div>
      <p suppressHydrationWarning className="mt-3 text-[12px] leading-relaxed text-fg/55">
        Written by {actorLabel(draft.actor)} {ago(draft.at)}. Tessera sends nothing on its own: copy it, send it from your mail, then mark it here. Drafts carrying account details,
        links or a promise of another payment are refused by policy.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Btn tone="secondary" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </Btn>
        <Btn busy={busy === "draft-SENT"} disabled={busy !== null && busy !== "draft-SENT"} onClick={() => resolve("SENT")}>
          I sent it
        </Btn>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => resolve("DISCARDED")}
          className="ml-auto cursor-pointer text-[12px] text-fg/55 underline underline-offset-4 hover:text-fg disabled:opacity-50"
        >
          Set it aside
        </button>
      </div>
    </div>
  );
}
