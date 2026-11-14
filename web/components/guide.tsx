"use client";

import type { ReactNode } from "react";
import type { Health } from "../../src/server/wire";
import { reasonText } from "@/lib/agent-verdict";
import type { TourStepId } from "@/lib/tour-steps";
import { Button, LinkButton } from "./ui";

/**
 * The words and the one action behind each getting-started step. Shared by the landing page's strip and the control
 * room's panel, so the two never drift: one place decides what step four is called and what pressing it does.
 */

const clip = (text: string, max = 160): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

export interface GuideInput {
  health: Health | null;
  /** The first incident waiting for a person, for the takeover step. */
  takeover: { id: string; reference: string; reason: string } | null;
  /** Kept for callers that still pass it; sending a payout is now a link to the composer. */
  onSeed?: () => void;
  onRun: (mode: "commander" | "adversary") => void;
  seeding?: boolean;
  running: boolean;
  /** Smaller buttons, for the control room's one-line sequence. */
  compact?: boolean;
}

export function guideCopy({ health, takeover, onRun, running, compact = false }: GuideInput): Record<TourStepId, { text: string; action: ReactNode }> {
  const idle = !health?.agent || running;
  const size = compact ? "md" : "lg";
  const where = health?.offline ? "the offline rehearsal" : "the Airwallex sandbox";
  const run = (label: string, mode: "commander" | "adversary") => (
    <Button onClick={() => onRun(mode)} disabled={idle} busy={running} variant="light" size={size} arrow>
      {label}
    </Button>
  );

  return {
    seed: {
      text: `Send a real payout through ${where}, signed with your own reason for paying. Tessera seals it in the ledger before a cent moves, then follows Airwallex's own events as they arrive.`,
      action: (
        <LinkButton href="/dashboard?compose=1" variant="light" size={size} arrow>
          Send a payout
        </LinkButton>
      ),
    },
    agent: {
      text: "The agent reads the board, weighs every incident and acts through thirteen typed tools. It may wait, replace, escalate or draft a reply; money moves only when policy agrees, and anything uncertain comes to you.",
      action: run("Let the agent work", "commander"),
    },
    adversary: {
      text: "Test the guardrails. Instruct the same agent to pay a supplier twice, swap the bank details or argue past a limit. Policy refuses every move, and what it cannot settle on its own is handed to a person, reasons attached.",
      action: run("Test the guardrails", "adversary"),
    },
    takeover: takeover
      ? {
          text: `You are the human in the loop. ${takeover.reference} is waiting on you: ${clip(reasonText(takeover.reason), 120)}`,
          action: (
            <LinkButton href={`/queue?id=${takeover.id}`} variant="light" size={size} arrow>
              Decide on {takeover.reference}
            </LinkButton>
          ),
        }
      : {
          text: "You are the human in the loop. Nothing needs you yet; run the agent again, and whatever it should not settle alone will be handed to you with its reasoning.",
          action: run("Run the agent again", "commander"),
        },
    certify: {
      text: `A payment earns its certificate only after a hold window and a line-by-line match against Airwallex. On this stage the hold lasts seconds, not a day: mark a payment paid under Simulate, then certify it yourself or let the agent.`,
      action: run("Run the agent again", "commander"),
    },
  };
}

/** A numbered disc. Done is a blue tick, current is white, pending is a quiet ring. */
export function Mark({ done, current, n }: { done: boolean; current: boolean; n: number }) {
  if (done) {
    return (
      <span aria-hidden className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-blue text-white">
        <svg viewBox="0 0 12 12" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2.5 6.5 5 9l4.5-5.5" />
        </svg>
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={`tnum inline-flex size-8 shrink-0 items-center justify-center rounded-full text-[13px] font-medium ${
        current ? "bg-white text-black" : "border border-white/20 text-muted"
      }`}
    >
      {n}
    </span>
  );
}

/** One step of the walkthrough, drawn as a row: the disc, the title, and the body of the step that is open. */
export function GuideStep({
  n,
  title,
  text,
  action,
  done,
  current,
}: {
  n: number;
  title: string;
  text: string;
  action: ReactNode;
  done: boolean;
  current: boolean;
}) {
  return (
    <li className={`relative flex gap-4 ${current ? "" : "opacity-80"} [&:last-child>span:first-child]:hidden`}>
      <span aria-hidden className="absolute left-4 top-10 h-[calc(100%-2.25rem)] w-px bg-white/10" />
      <Mark done={done} current={current} n={n} />
      <div className="min-w-0 flex-1 pb-6">
        <p className={`text-[14.5px] ${current ? "font-medium text-white" : done ? "text-soft" : "text-muted"}`}>
          <span className="sr-only">Step {n}: </span>
          {title}
        </p>
        {current ? (
          <div className="mt-2.5 rounded-2xl border border-blue/35 bg-[#070d20]/70 p-4">
            <p className="text-[13.5px] leading-relaxed text-soft">{text}</p>
            <div className="mt-4">{action}</div>
          </div>
        ) : null}
      </div>
    </li>
  );
}

/** The completion line, wherever the walkthrough is shown. */
export function LoopComplete({ className = "" }: { className?: string }) {
  return (
    <p className={`flex items-center gap-3 text-[13.5px] text-soft ${className}`}>
      <Mark done current={false} n={0} />
      The whole loop, seen through: paid, worked, tested, decided by a person, certified.
    </p>
  );
}
