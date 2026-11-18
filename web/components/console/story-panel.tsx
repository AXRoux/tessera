"use client";

import { useId, useState } from "react";
import { Acknowledged, api, ApiProblem } from "@/lib/client-api";
import { money } from "@/lib/format";
import type { IncidentView, Story, StoryStep } from "../../../src/server/wire";
import { Icon } from "../landing/icons";
import { Btn } from "../kit/metal";
import { Chip } from "../kit/widgets";
import { TextArea } from "./fields";
import { SupplierMark } from "../suppliers/supplier-mark";
import type { RunAction } from "./actions-panel";

const ACTOR_NAME = { bank: "Airwallex", you: "You" } as const;

function Who({ step, story }: { step: StoryStep; story: Story }) {
  if (step.actor === "supplier") return <SupplierMark supplier={story.supplier} size={30} />;
  return (
    <span className={`flex size-[30px] shrink-0 items-center justify-center rounded-[9px] ${step.actor === "bank" ? "bg-fg text-canvas" : "well text-fg/70"}`}>
      <Icon name={step.actor === "bank" ? "wallet" : "user"} className="size-4" />
    </span>
  );
}

/**
 * The invoice's story, step by step: the supplier's and the bank's parts, which can be played here (on the sandbox or
 * offline), and a person's moves, which go to the ordinary routes and are answered by policy exactly as they would be
 * without a story. The one step that is next carries its button; what Tessera made of each finished step sits under it.
 */
export function StoryPanel({ view, busy, run }: { view: IncidentView; busy: string | null; run: RunAction }) {
  const story = view.story;
  const noteId = useId();
  const [note, setNote] = useState("");
  if (!story) return null;
  const id = view.obligation.id;
  const allowed = view.assessment?.decision.allowed ?? [];
  const who = story.supplier.name;

  const play = (step: StoryStep) =>
    run(`story-${step.id}`, async () => {
      await api(`obligations/${id}/story/play`, Acknowledged, { method: "POST", body: { step: step.id } });
      return {
        tone: "ok",
        title: step.actor === "bank" ? "Airwallex update received" : `Email from ${who}`,
        lines: [step.actor === "bank" ? "Tessera read the transfer back from Airwallex and reassessed the invoice." : "Filed with the invoice. Only its fingerprint goes in the ledger."],
      };
    });

  const replace = () =>
    run("story-replace", async () => {
      await api(`obligations/${id}/replace`, Acknowledged, { method: "POST" });
      return { tone: "ok", title: "Replacement sent", lines: ["New transfer under a fresh request ID. The original stays cancelled."] };
    });

  // The point of this step is the refusal: a 409 from policy is the expected answer, shown as such.
  const retry = () =>
    run("story-retry", async () => {
      try {
        await api(`obligations/${id}/replace`, Acknowledged, { method: "POST" });
        return { tone: "ok", title: "Sent", lines: ["Policy allowed it."] };
      } catch (error) {
        if (error instanceof ApiProblem && error.status === 409) {
          return { tone: "refused", title: "Declined by policy", lines: error.problem.reasons ?? [error.problem.message] };
        }
        throw error;
      }
    });

  const amount = money(view.obligation.amountMinor, view.obligation.currency);
  const card = view.invoiceCard ?? null;

  const askCard = () =>
    run("story-card", async () => {
      await api(`obligations/${id}/card`, Acknowledged, { method: "POST", body: {} });
      return { tone: "ok", title: "Card requested", lines: [`A single-use Visa card for exactly ${amount}, payable only to ${story.supplier.legalName}. It waits for your signature.`] };
    });

  const signCard = (cardId: string, text: string) =>
    run("story-card-sign", async () => {
      await api(`cards/${cardId}/approve`, Acknowledged, { method: "POST", body: { note: text } });
      setNote("");
      return { tone: "ok", title: "Card signed and issued", lines: ["Airwallex issued it with the invoice's terms as its controls."] };
    });

  const payCard = () =>
    run("story-card-pay", async () => {
      const result = await api(`obligations/${id}/card/pay`, Acknowledged, { method: "POST", body: {} });
      return String(result.outcome) === "PAID"
        ? { tone: "ok", title: "Paid through Visa TAP", lines: [`${who}'s checkout verified the agent's signature and charged exactly ${amount}.`] }
        : { tone: "refused", title: "The checkout did not go through", lines: [String(result.next ?? "Tessera will reassess.")] };
    });

  const certify = () =>
    run("story-certify", async () => {
      await api(`obligations/${id}/close`, Acknowledged, { method: "POST" });
      return { tone: "ok", title: "Reconciled and certified", lines: ["Matched line by line against Airwallex. Certificate signed."] };
    });

  function button(step: StoryStep) {
    if (step.play) {
      if (!story!.playable) return <p className="text-[13px] text-fg/50">Waiting on {step.actor === "bank" ? "Airwallex" : who}.</p>;
      const label = step.actor === "bank" ? "Get the next Airwallex update" : `Receive ${who}'s email`;
      return (
        <Btn busy={busy === `story-${step.id}`} disabled={busy !== null} onClick={() => play(step)} icon={<Icon name={step.actor === "bank" ? "bolt" : "mail"} className="size-4" />}>
          {label}
        </Btn>
      );
    }
    if (step.action === "replace") {
      const issuingOff = card?.state === "FAILED" && /issuance/i.test(card.lastError ?? "");
      const byCard = step.alt === "card" && allowed.includes("PAY_BY_CARD");
      return (
        <div className="space-y-2.5">
          <div className="grid gap-2">
            <div className="well space-y-2 rounded-[16px]! p-3">
              <p className="text-[14px] font-semibold">Bank transfer</p>
              <p className="text-[13.5px] leading-snug text-fg/60">A new transfer to the account on file. Arrives within the usual settlement window.</p>
              <Btn block busy={busy === "story-replace"} disabled={busy !== null || !allowed.includes("REPLACE")} onClick={replace}>
                Send replacement
              </Btn>
            </div>
            {byCard ? (
              <div className="well space-y-2 rounded-[16px]! p-3">
                <p className="text-[14px] font-semibold">Single-use Visa card</p>
                <p className="text-[13.5px] leading-snug text-fg/60">
                  {issuingOff ? "Card issuing isn't enabled on this Airwallex account." : `Exactly ${amount}, payable only to ${who}. You sign; the agent pays through Visa TAP. Clears in minutes.`}
                </p>
                <Btn block tone="secondary" busy={busy === "story-card"} disabled={busy !== null || issuingOff} onClick={askCard}>
                  Pay by Visa card
                </Btn>
              </div>
            ) : null}
          </div>
        </div>
      );
    }
    if (step.action === "card-sign" && card) {
      const text = note.trim() || `${who} is waiting on ${view.obligation.reference}; paying it once by single-use card.`;
      return (
        <div className="space-y-2.5">
          <label htmlFor={noteId} className="block text-[13px] text-fg/60">
            Your reason, signed onto the card
          </label>
          <TextArea id={noteId} value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} placeholder={text} />
          <Btn busy={busy === "story-card-sign"} disabled={busy !== null} onClick={() => signCard(card.id, text)}>
            Sign the card
          </Btn>
        </div>
      );
    }
    if (step.action === "card-pay") {
      return (
        <Btn busy={busy === "story-card-pay"} disabled={busy !== null} onClick={payCard}>
          Pay through Visa TAP
        </Btn>
      );
    }
    if (step.action === "retry") {
      return (
        <Btn tone="secondary" busy={busy === "story-retry"} disabled={busy !== null} onClick={retry}>
          {step.title}
        </Btn>
      );
    }
    if (step.action === "certify") {
      const ready = allowed.includes("CLOSE");
      return (
        <div className="flex flex-wrap items-center gap-3">
          <Btn busy={busy === "story-certify"} disabled={busy !== null || !ready} onClick={certify}>
            Certify
          </Btn>
          {!ready ? <span className="text-[13px] text-fg/50">Available once the hold window passes.</span> : null}
        </div>
      );
    }
    if (step.id === "card-clear") return <p className="text-[13.5px] text-fg/55">Waiting for Visa to clear the charge. Tessera proves it against the signed terms the moment it does.</p>;
    return null;
  }

  // What has happened, and the one thing next: nothing further is shown before it happens.
  const shown = story.steps.filter((s) => s.state !== "later");

  return (
    <div className="space-y-4">
      <div className="tile flex items-center gap-3 rounded-[20px]! p-3.5">
        <SupplierMark supplier={story.supplier} size={42} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[16px] font-semibold">{story.supplier.legalName}</p>
          <p className="truncate text-[13.5px] leading-snug text-fg/55">
            {view.obligation.reference} · {view.obligation.method} {view.obligation.currency}
          </p>
        </div>
      </div>

      <ol className="relative space-y-1">
        {shown.map((step, i) => {
          const next = step.state === "next";
          const yours = step.state === "yours";
          const later = step.state === "later";
          return (
            <li key={step.id} className="relative flex gap-3">
              {i < shown.length - 1 ? <span aria-hidden className="absolute left-[14.5px] top-[34px] bottom-[-6px] w-px bg-fg/10" /> : null}
              <span className={`relative z-[1] mt-1 ${later ? "opacity-40" : ""}`}>
                <Who step={step} story={story} />
              </span>
              <div className={`min-w-0 flex-1 pb-3 ${next ? "tile rounded-[18px]! p-3.5 ring-2 ring-accent" : yours ? "tile rounded-[18px]! p-3.5 ring-1 ring-warn/60" : "pt-1.5"}`}>
                <div className="flex items-start justify-between gap-2">
                  <p className={`text-[15.5px] leading-snug ${later ? "text-fg/40" : "font-medium text-fg"}`}>
                    <span className="mr-1.5 text-[13px] font-normal text-fg/45">{step.actor === "supplier" ? who : ACTOR_NAME[step.actor]}</span>
                    {step.title}
                  </p>
                  {step.state === "done" ? (
                    <span aria-label="done" className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-accent text-white">
                      <Icon name="check" className="size-2.5" />
                    </span>
                  ) : next ? (
                    <Chip tone="accent" pulse>
                      Next
                    </Chip>
                  ) : yours ? (
                    <Chip tone="warn">To do</Chip>
                  ) : null}
                </div>
                {step.state === "done" && step.after ? <p className="mt-1 text-[14px] leading-snug text-fg/60">{step.after}</p> : null}
                {next ? <div className="mt-3">{button(step)}</div> : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
