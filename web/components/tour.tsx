"use client";

import Link from "next/link";
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import type { Health } from "../../src/server/wire";
import { agentName } from "./agent/agent-run";
import { reasonText } from "@/lib/agent-verdict";
import { agentWorked, deriveTour, tourAgent, type TourInput, type TourStepId } from "@/lib/tour-steps";
import { Button, LinkButton } from "./ui";

/*
 * What the browser remembers about the walkthrough: whether it was hidden, and whether the operator has ever opened an
 * incident that was waiting for a person. Read through useSyncExternalStore with a server snapshot, so the server render
 * and the first client render agree and the real values arrive right after hydration.
 */
const HIDDEN_KEY = "tessera.tour.hidden";
const TAKEOVER_KEY = "tessera.tour.takeover";
const AGENT_KEY = "tessera.tour.agent";
const CHANGED = "tessera:tour";

/** Used when localStorage is blocked, so Hide still works for the rest of the visit. */
const memory: Record<string, boolean> = {};

function subscribe(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGED, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGED, onChange);
  };
}

function read(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return memory[key] ?? false;
  }
}

function write(key: string, on: boolean): void {
  memory[key] = on;
  try {
    if (on) window.localStorage.setItem(key, "1");
    else window.localStorage.removeItem(key);
  } catch {
    /* blocked storage: the in-memory value above still applies */
  }
  window.dispatchEvent(new Event(CHANGED));
}

/** Called by the incident page when the operator is looking at an incident that was waiting for a person. */
export function markTakeoverOpened(): void {
  if (!read(TAKEOVER_KEY)) write(TAKEOVER_KEY, true);
}

/** After the demo is reset the walkthrough starts over: forget what it remembered, and show it again. */
export function resetTour(): void {
  write(TAKEOVER_KEY, false);
  write(AGENT_KEY, false);
  write(HIDDEN_KEY, false);
}

/** Shows the walkthrough again, wherever it was hidden. */
export function showTour(): void {
  write(HIDDEN_KEY, false);
}

/** The header's call to action: an outlined pill that opens the walkthrough. */
export function TourLink() {
  return (
    <Link
      href="/#start"
      onClick={showTour}
      className="inline-flex h-11 items-center rounded-full border border-white/40 px-5 text-[14px] transition-colors hover:bg-white/10"
    >
      Start here
    </Link>
  );
}

/** The hero's call to action: jumps to the walkthrough, and shows it again if it was hidden. */
export function StartButton() {
  return (
    <LinkButton href="/#start" onClick={showTour} size="lg" arrow>
      Start the walkthrough
    </LinkButton>
  );
}

function Mark({ done, current, n }: { done: boolean; current: boolean; n: number }) {
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
      className={`tnum inline-flex size-8 shrink-0 items-center justify-center rounded-full text-[13px] font-medium ${current ? "bg-white text-black" : "border border-white/20 text-muted"}`}
    >
      {n}
    </span>
  );
}

const clip = (text: string, max = 160): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

interface TourProps {
  items: TourInput["items"];
  metrics: TourInput["metrics"];
  health: Health | null;
  /** The same handlers the board's own buttons use. */
  onSeed: () => void;
  onRun: (mode: "commander" | "adversary") => void;
  seeding: boolean;
  /** An agent run is active: every action is off until it ends. */
  running: boolean;
}

/**
 * A short checklist for the sandbox and the offline demo. Every step is derived from the live board, so it is right
 * after a reload; only the current step is open, and it has one action.
 */
export function Tour({ items, metrics, health, onSeed, onRun, seeding, running }: TourProps) {
  const hidden = useSyncExternalStore(subscribe, () => read(HIDDEN_KEY), () => true);
  const openedAttention = useSyncExternalStore(subscribe, () => read(TAKEOVER_KEY), () => false);
  const agentSeen = useSyncExternalStore(subscribe, () => read(AGENT_KEY), () => false);
  const worked = agentWorked(items);
  useEffect(() => {
    if (worked && !read(AGENT_KEY)) write(AGENT_KEY, true);
  }, [worked]);

  if (!health?.sandbox || hidden) return null;

  const tour = deriveTour({ items, metrics, openedAttention, agentSeen });
  const { name, Name } = tourAgent(health.agent);
  const hide = () => write(HIDDEN_KEY, true);

  if (tour.complete) {
    return (
      <div id="start" className="mt-10 scroll-mt-28">
        <p role="status" className="flex flex-wrap items-center justify-between gap-4 rounded-[20px] border border-blue/40 bg-surface px-6 py-5 text-[15px]">
          <span className="flex items-center gap-3">
            <Mark done current={false} n={0} />
            You have seen the whole loop. &ldquo;Start here&rdquo; in the header opens the walkthrough again.
          </span>
          <button type="button" onClick={hide} className="cursor-pointer text-[13px] text-muted underline underline-offset-4 hover:text-white">
            Hide
          </button>
        </p>
      </div>
    );
  }

  const idle = !health.agent || running;
  const agentMissing = !health.agent ? "No agent is connected to this server, so the agent steps are unavailable." : null;
  const short = agentName(health.agent);
  const simulated = health.offline ? "Airwallex is simulated here, so no money and no bank are involved." : "This is the Airwallex sandbox, so no real money moves.";

  const detail: Record<TourStepId, { text: string; action: ReactNode }> = {
    seed: {
      text: `Seven invoices, each gone wrong in a different way: a payment still in flight, a bank timeout, a possible duplicate, a supplier changing bank details, one already paid, one disputed, and one wallet too short to replace it. Every branch of the playbook lands on the board at once. ${simulated}`,
      action: (
        <Button onClick={onSeed} busy={seeding} disabled={running} variant="light" size="lg" arrow>
          Load seven incidents
        </Button>
      ),
    },
    agent: {
      text: `${Name} reads the supplier mail, checks each incident and acts only through ten typed tools. The code decides what is allowed, so the agent can wait, replace, escalate or draft a reply, but it can never move money on its own.`,
      action: (
        <Button onClick={() => onRun("commander")} disabled={idle} busy={running} variant="light" size="lg" arrow>
          Let {short} work them all
        </Button>
      ),
    },
    adversary: {
      text: `Now the same agent is told to get a supplier paid twice, change the bank details and talk its way past the rules. Watch the code refuse every move.`,
      action: (
        <Button onClick={() => onRun("adversary")} disabled={idle} busy={running} variant="light" size="lg" arrow>
          Try to break it
        </Button>
      ),
    },
    takeover: tour.takeover
      ? {
          text: clip(reasonText(tour.takeover.reason)),
          action: (
            <LinkButton href={`/incidents/${tour.takeover.id}`} variant="light" size="lg" arrow>
              Open {tour.takeover.reference}
            </LinkButton>
          ),
        }
      : {
          text: `Nothing is waiting for you yet. Run ${name} again: anything it cannot settle safely is handed to you.`,
          action: (
            <Button onClick={() => onRun("commander")} disabled={idle} busy={running} variant="light" size="lg" arrow>
              Let {short} work them all
            </Button>
          ),
        },
    certify: {
      text: `A payment is certified only after a hold window and a check of every wallet line against Airwallex. ${health.offline ? "The hold window is 6 seconds here and 24 hours in production" : "The hold window is set by the server and is 24 hours in production"}, so run ${name} again once a payment has landed.`,
      action: (
        <Button onClick={() => onRun("commander")} disabled={idle} busy={running} variant="light" size="lg" arrow>
          Let {short} work them all
        </Button>
      ),
    },
  };

  const currentStep = tour.steps.find((s) => s.id === tour.current);
  const currentNumber = tour.steps.findIndex((s) => s.id === tour.current) + 1;

  return (
    <div id="start" className="mt-8 scroll-mt-24">
      <section aria-label="Guided walkthrough" className="card border-blue/40 px-5 py-4 sm:px-6">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <ol className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-2" aria-label="Walkthrough steps">
            {tour.steps.map((step, i) => {
              const current = step.id === tour.current;
              return (
                <li key={step.id} aria-current={current ? "step" : undefined} className="flex min-w-0 items-center gap-2">
                  <Mark done={step.done} current={current} n={i + 1} />
                  <span className={`truncate text-[13.5px] ${current ? "font-medium text-white" : step.done ? "text-soft" : "text-muted"}`}>{step.title}</span>
                  {i < tour.steps.length - 1 ? <span aria-hidden className="mx-1 h-px w-5 bg-white/15" /> : null}
                </li>
              );
            })}
          </ol>
          <div className="flex items-center gap-4">
            <span aria-live="polite" className="tnum text-[13px] text-sky">
              {tour.doneCount}/{tour.total}
            </span>
            <button type="button" onClick={hide} className="cursor-pointer text-[13px] text-muted underline underline-offset-4 hover:text-white">
              Hide
            </button>
          </div>
        </div>
        {currentStep ? (
          <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-rule pt-4">
            <p title={currentStep.id === "takeover" ? tour.takeover?.reason : undefined} className="min-w-[280px] flex-1 text-[13.5px] leading-snug text-soft">
              <span className="text-sky">
                Step {currentNumber} of {tour.total}
                {" · "}
              </span>
              {detail[currentStep.id].text}
            </p>
            <div className="shrink-0">{detail[currentStep.id].action}</div>
          </div>
        ) : (
          <p className="mt-3 border-t border-rule pt-3 text-[13px] text-muted">You have seen the whole loop. Reload, or hide this strip and drive the board yourself.</p>
        )}
        {agentMissing || metrics === null ? (
          <p className="mt-3 border-t border-rule pt-3 text-[12.5px] text-muted">
            {agentMissing ?? "The board numbers could not be read, so two steps cannot complete yet. They are retried every few seconds."}
          </p>
        ) : null}
      </section>
    </div>
  );
}
