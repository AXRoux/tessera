"use client";

import type { ReactNode } from "react";
import type { Health } from "../../src/server/wire";
import { reasonText } from "@/lib/agent-verdict";
import type { TourStepId } from "@/lib/tour-steps";
import { agentName } from "./agent/agent-run";
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
  onSeed: () => void;
  onRun: (mode: "commander" | "adversary") => void;
  seeding: boolean;
  running: boolean;
}

export function guideCopy({ health, takeover, onSeed, onRun, seeding, running }: GuideInput): Record<TourStepId, { text: string; action: ReactNode }> {
  const name = agentName(health?.agent);
  const Name = agentName(health?.agent, true);
  const short = agentName(health?.agent);
  const idle = !health?.agent || running;
  const simulated = health?.offline ? "Airwallex is simulated here, so no money and no bank are involved." : "This is the Airwallex sandbox, so no real money moves.";
  const run = (label: string, mode: "commander" | "adversary") => (
    <Button onClick={() => onRun(mode)} disabled={idle} busy={running} variant="light" size="lg" arrow>
      {label}
    </Button>
  );

  return {
    seed: {
      text: `Seven invoices, each gone wrong in a different way: a payment still in flight, a bank timeout, a possible duplicate, a supplier changing bank details, one already paid, one disputed, and one wallet too short to replace it. Every branch of the playbook lands on the board at once. ${simulated}`,
      action: (
        <Button onClick={onSeed} busy={seeding} disabled={running} variant="light" size="lg" arrow>
          Load the incidents
        </Button>
      ),
    },
    agent: {
      text: `${Name} reads the supplier mail, checks each incident and acts only through ten typed tools. The code decides what is allowed, so the agent can wait, replace, escalate or draft a reply, but it can never move money on its own.`,
      action: run(`Let ${short} work them all`, "commander"),
    },
    adversary: {
      text: "Now the same agent is told to get a supplier paid twice, change the bank details and talk its way past the rules. Watch the code refuse every move.",
      action: run("Try to break it", "adversary"),
    },
    takeover: takeover
      ? {
          text: clip(reasonText(takeover.reason)),
          action: (
            <LinkButton href={`/incidents/${takeover.id}`} variant="light" size="lg" arrow>
              Open {takeover.reference}
            </LinkButton>
          ),
        }
      : {
          text: `Nothing is waiting for you yet. Run ${name} again: anything it cannot settle safely is handed to you.`,
          action: run(`Let ${short} work them all`, "commander"),
        },
    certify: {
      text: `A payment is certified only after a hold window and a check of every wallet line against Airwallex. ${
        health?.offline ? "The hold window is 6 seconds here and 24 hours in production" : "The hold window is set by the server and is 24 hours in production"
      }, so run ${name} again once a payment has landed.`,
      action: run(`Let ${short} work them all`, "commander"),
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
      You have seen the whole loop: load, work, break, take over, certify.
    </p>
  );
}
