"use client";

import Link from "next/link";
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import type { Health } from "../../src/server/wire";
import { agentName } from "./agent/agent-run";
import { reasonText } from "@/lib/agent-verdict";
import { agentWorked, deriveTour, tourAgent, type TourInput, type TourStepId } from "@/lib/tour-steps";
import { Button, Frame, Label, LinkButton, PanelHeader } from "./ui";

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

/** The header's "Start here" link: shows the walkthrough again, wherever it was hidden. */
export function TourLink() {
  return (
    <Link href="/#start" onClick={() => write(HIDDEN_KEY, false)} className="label hover:text-blue">
      Start here
    </Link>
  );
}

/** The hero's call to action: jumps to the walkthrough, and shows it again if it was hidden. */
export function StartButton() {
  return (
    <LinkButton href="/#start" onClick={() => write(HIDDEN_KEY, false)}>
      Start the walkthrough
    </LinkButton>
  );
}

function Mark({ done, current, n }: { done: boolean; current: boolean; n: number }) {
  if (done) {
    return (
      <span aria-hidden className="inline-flex size-6 shrink-0 items-center justify-center bg-blue text-paper">
        <svg viewBox="0 0 12 12" className="size-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square">
          <path d="M2 6.5 5 9.5 10 3" />
        </svg>
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={`tnum inline-flex size-6 shrink-0 items-center justify-center text-[11px] font-medium ${current ? "bg-ink text-paper" : "border border-rule text-muted"}`}
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
      <div id="start" className="mt-8 scroll-mt-8">
        <p role="status" className="flex flex-wrap items-center justify-between gap-3 border border-blue bg-wash px-5 py-4 text-sm">
          <span>You have seen the whole loop. &ldquo;Start here&rdquo; in the header opens this list again.</span>
          <button type="button" onClick={hide} className="label cursor-pointer text-ink hover:text-blue">
            Hide
          </button>
        </p>
      </div>
    );
  }

  const idle = !health.agent || running;
  const agentMissing = !health.agent ? "No agent is connected to this server, so the agent steps are unavailable." : null;
  const short = agentName(health.agent);
  const simulated = health.offline ? "Airwallex is simulated here, so no money and no bank are involved." : "This is the Airwallex sandbox: no real money moves.";

  const detail: Record<TourStepId, { text: string; action: ReactNode }> = {
    seed: {
      text: `Opens seven invoices that each go wrong in a different way, one of them paid from a wallet too short to replace it, so every branch of the playbook is on the board at once. ${simulated}`,
      action: (
        <Button onClick={onSeed} busy={seeding} disabled={running}>
          Load seven incidents
        </Button>
      ),
    },
    agent: {
      text: `${Name} reads supplier mail, checks each incident and acts through a fixed set of typed tools. The code decides what is allowed; the agent cannot move money on its own.`,
      action: (
        <Button onClick={() => onRun("commander")} disabled={idle} busy={running}>
          Let {short} work them all
        </Button>
      ),
    },
    adversary: {
      text: `An adversary agent tries to get a supplier paid twice, change the bank details and talk its way past the rules. Watch the code refuse each move.`,
      action: (
        <Button onClick={() => onRun("adversary")} disabled={idle} busy={running}>
          Try to break it
        </Button>
      ),
    },
    takeover: tour.takeover
      ? {
          text: clip(reasonText(tour.takeover.reason)),
          action: <LinkButton href={`/incidents/${tour.takeover.id}`}>Open {tour.takeover.reference}</LinkButton>,
        }
      : {
          text: `Nothing is waiting for you yet. Run ${name} again: incidents it cannot settle safely are handed to you.`,
          action: (
            <Button onClick={() => onRun("commander")} disabled={idle} busy={running}>
              Let {short} work them all
            </Button>
          ),
        },
    certify: {
      text: `A payment is certified only after a hold window and a check of every wallet line against Airwallex. ${health.offline ? "The hold window is 6 s here, 24 h in production" : "The hold window is set by the server and is 24 h in production"}, so run ${name} again once a payment has landed.`,
      action: (
        <Button onClick={() => onRun("commander")} disabled={idle} busy={running}>
          Let {short} work them all
        </Button>
      ),
    },
  };

  return (
    <div id="start" className="mt-8 scroll-mt-8">
      <Frame tone="blue">
        <PanelHeader
          title="Start here"
          right={
            <span className="flex items-center gap-4">
              <span aria-live="polite" className="tnum label text-blue">
                {tour.doneCount} of {tour.total}
              </span>
              <button type="button" onClick={hide} className="label cursor-pointer text-ink hover:text-blue">
                Hide
              </button>
            </span>
          }
        />
        <ol className="divide-y divide-rule">
          {tour.steps.map((step, i) => {
            const current = step.id === tour.current;
            return (
              <li key={step.id} aria-current={current ? "step" : undefined} className={current ? "bg-wash px-5 py-5" : "px-5 py-3.5"}>
                <div className="flex items-center gap-4">
                  <Mark done={step.done} current={current} n={i + 1} />
                  <span className={`text-sm ${current ? "font-semibold" : step.done ? "text-ink" : "text-muted"}`}>
                    {step.title}
                    {step.done ? <span className="sr-only"> (done)</span> : null}
                  </span>
                </div>
                {current ? (
                  <div className="mt-3 flex flex-col gap-4 pl-10 sm:flex-row sm:items-center sm:justify-between">
                    <p title={step.id === "takeover" ? tour.takeover?.reason : undefined} className="max-w-2xl text-sm leading-relaxed text-muted">
                      {detail[step.id].text}
                    </p>
                    <div className="shrink-0">{detail[step.id].action}</div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
        {agentMissing ? <p className="border-t border-rule px-5 py-3.5 text-xs text-muted">{agentMissing}</p> : null}
        {metrics === null ? (
          <p className="border-t border-rule px-5 py-3.5 text-xs text-muted">
            <Label>Numbers unavailable</Label> The board numbers could not be read, so steps 3 and 5 cannot be marked done yet. They are retried every few seconds.
          </p>
        ) : null}
      </Frame>
    </div>
  );
}
