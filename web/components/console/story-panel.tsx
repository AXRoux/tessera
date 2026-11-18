"use client";

import { Acknowledged, api, ApiProblem } from "@/lib/client-api";
import type { IncidentView, Story, StoryStep } from "../../../src/server/wire";
import { Icon } from "../landing/icons";
import { Btn } from "../kit/metal";
import { Chip } from "../kit/widgets";
import { SupplierMark } from "../suppliers/supplier-mark";
import type { RunAction } from "./actions-panel";

const ACTOR_NAME = { bank: "The bank", you: "You" } as const;

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
  if (!story) return null;
  const id = view.obligation.id;
  const allowed = view.assessment?.decision.allowed ?? [];
  const who = story.supplier.name;

  const play = (step: StoryStep) =>
    run(`story-${step.id}`, async () => {
      await api(`obligations/${id}/story/play`, Acknowledged, { method: "POST", body: { step: step.id } });
      return {
        tone: "ok",
        title: step.actor === "bank" ? "The bank answered" : `${who} wrote`,
        lines: [step.actor === "bank" ? "Played on the simulator; Tessera read the result back from Airwallex and weighed the invoice again." : "Their message is in the inbox; only its fingerprint is in the ledger."],
      };
    });

  const replace = () =>
    run("story-replace", async () => {
      await api(`obligations/${id}/replace`, Acknowledged, { method: "POST" });
      return { tone: "ok", title: "Replacement sent", lines: ["A new payment under a fresh request ID. The original stays cancelled."] };
    });

  // The point of this step is the refusal: a 409 from policy is the expected answer, shown as such.
  const retry = () =>
    run("story-retry", async () => {
      try {
        await api(`obligations/${id}/replace`, Acknowledged, { method: "POST" });
        return { tone: "refused", title: "It went through", lines: ["Policy allowed this one. The story expected a refusal."] };
      } catch (error) {
        if (error instanceof ApiProblem && error.status === 409) {
          return { tone: "refused", title: "Refused. One open payment per invoice.", lines: error.problem.reasons ?? [error.problem.message] };
        }
        throw error;
      }
    });

  const certify = () =>
    run("story-certify", async () => {
      await api(`obligations/${id}/close`, Acknowledged, { method: "POST" });
      return { tone: "ok", title: "Reconciled and certified", lines: ["Every wallet line matched against Airwallex, and the certificate is signed."] };
    });

  function button(step: StoryStep) {
    if (step.play) {
      if (!story!.playable) return <p className="text-[12px] text-fg/50">The supplier and the bank play their parts only on the sandbox or offline.</p>;
      const label = step.actor === "bank" ? "Play the bank" : step.id === "resend" ? `Have ${who} send it again` : `Have ${who} write`;
      return (
        <Btn busy={busy === `story-${step.id}`} disabled={busy !== null} onClick={() => play(step)} icon={<Icon name={step.actor === "bank" ? "bolt" : "mail"} className="size-4" />}>
          {label}
        </Btn>
      );
    }
    if (step.action === "replace") {
      return (
        <Btn busy={busy === "story-replace"} disabled={busy !== null || !allowed.includes("REPLACE")} onClick={replace}>
          Replace
        </Btn>
      );
    }
    if (step.action === "retry") {
      return (
        <Btn tone="secondary" busy={busy === "story-retry"} disabled={busy !== null} onClick={retry}>
          Press it
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
          {!ready ? <span className="text-[12px] text-fg/50">Opens when the hold window passes.</span> : null}
        </div>
      );
    }
    return null;
  }

  const done = story.steps.filter((s) => s.state === "done").length;
  const total = story.steps.filter((s) => s.id !== "yours").length;

  return (
    <div className="space-y-4">
      <div className="tile flex items-center gap-3 rounded-[20px]! p-3.5">
        <SupplierMark supplier={story.supplier} size={42} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-semibold">
            {who} · {story.story.label}
          </p>
          <p className="line-clamp-2 text-[11.5px] leading-snug text-fg/55">{story.story.ending}</p>
        </div>
        <span className="readout shrink-0 text-[11px] text-fg/45">
          {done}/{total}
        </span>
      </div>

      <ol className="relative space-y-1">
        {story.steps.map((step, i) => {
          const next = step.state === "next";
          const yours = step.state === "yours";
          const later = step.state === "later";
          return (
            <li key={step.id} className="relative flex gap-3">
              {i < story.steps.length - 1 ? <span aria-hidden className="absolute left-[14.5px] top-[34px] bottom-[-6px] w-px bg-fg/10" /> : null}
              <span className={`relative z-[1] mt-1 ${later ? "opacity-40" : ""}`}>
                <Who step={step} story={story} />
              </span>
              <div className={`min-w-0 flex-1 pb-3 ${next ? "tile rounded-[18px]! p-3.5 ring-2 ring-accent" : yours ? "tile rounded-[18px]! p-3.5 ring-1 ring-warn/60" : "pt-1.5"}`}>
                <div className="flex items-start justify-between gap-2">
                  <p className={`text-[13px] leading-snug ${later ? "text-fg/40" : "font-medium text-fg"}`}>
                    <span className="mr-1.5 text-[11px] font-normal text-fg/45">{step.actor === "supplier" ? who : ACTOR_NAME[step.actor]}</span>
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
                    <Chip tone="warn">Yours</Chip>
                  ) : null}
                </div>
                {step.state === "done" && step.after ? <p className="mt-1 text-[11.5px] leading-snug text-fg/55">{step.after}</p> : null}
                {next ? <div className="mt-3">{button(step)}</div> : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
