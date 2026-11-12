"use client";

import Link from "next/link";
import { useEffect, useSyncExternalStore } from "react";
import type { Health } from "../../src/server/wire";
import { agentWorked, deriveTour, tourAgent, type TourInput } from "@/lib/tour-steps";
import { GuideStep, guideCopy, LoopComplete, Mark } from "./guide";
import { LinkButton } from "./ui";

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

/** Seen by the control room's guide, which is driven by the same five steps. */
export function useTourState(items: TourInput["items"], metrics: TourInput["metrics"]) {
  const openedAttention = useSyncExternalStore(subscribe, () => read(TAKEOVER_KEY), () => false);
  const agentSeen = useSyncExternalStore(subscribe, () => read(AGENT_KEY), () => false);
  const worked = agentWorked(items);
  useEffect(() => {
    if (worked && !read(AGENT_KEY)) write(AGENT_KEY, true);
  }, [worked]);
  return deriveTour({ items, metrics, openedAttention, agentSeen });
}

/** The header's call to action: an outlined pill that opens the walkthrough in the control room. */
export function TourLink() {
  return (
    <Link
      href="/dashboard"
      onClick={showTour}
      className="inline-flex h-11 items-center rounded-full border border-white/40 px-5 text-[14px] transition-colors hover:bg-white/10"
    >
      Start here
    </Link>
  );
}

/** The hero's call to action: opens the control room, where the walkthrough lives, and shows it again if it was hidden. */
export function StartButton({ label = "Start here" }: { label?: string }) {
  return (
    <LinkButton href="/dashboard" onClick={showTour} size="lg" arrow>
      {label}
    </LinkButton>
  );
}

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
  const tour = useTourState(items, metrics);

  if (!health?.sandbox || hidden) return null;

  const name = tourAgent(health.agent).name;
  const hide = () => write(HIDDEN_KEY, true);

  if (tour.complete) {
    return (
      <div id="start" className="mt-10 scroll-mt-28">
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-[20px] border border-blue/40 bg-surface px-6 py-5">
          <LoopComplete />
          <span className="flex items-center gap-4">
            <Link href="/dashboard" className="text-[13px] text-sky underline underline-offset-4 hover:text-white">
              Open the control room
            </Link>
            <button type="button" onClick={hide} className="cursor-pointer text-[13px] text-muted underline underline-offset-4 hover:text-white">
              Hide
            </button>
          </span>
        </div>
      </div>
    );
  }

  const idle = !health.agent || running;
  const agentMissing = !health.agent ? "No agent is connected to this server, so the agent steps are unavailable." : null;
  const detail = guideCopy({ health, takeover: tour.takeover, onSeed, onRun, seeding, running });
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
            <Link href="/dashboard" className="text-[13px] text-sky underline underline-offset-4 hover:text-white">
              Control room
            </Link>
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
        ) : null}
        {agentMissing || idle ? (
          <p className="mt-3 border-t border-rule pt-3 text-[12.5px] text-muted">
            {agentMissing ?? "An agent run is in flight, so the other buttons wait for it."}
          </p>
        ) : null}
      </section>
    </div>
  );
}

/** The same five steps as a vertical panel: what the control room shows while the loop is unfinished. */
export function Guide({ items, metrics, health, onSeed, onRun, seeding, running }: TourProps) {
  const tour = useTourState(items, metrics);
  const { name } = tourAgent(health?.agent);
  const detail = guideCopy({ health, takeover: tour.takeover, onSeed, onRun, seeding, running });
  const idle = !health?.agent || running;

  if (tour.complete) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-4">
        <LoopComplete />
        <p className="text-[13px] text-muted">Start over with Send a test invoice, or run {name} again on a fresh incident.</p>
      </div>
    );
  }

  return (
    <ol className="mt-5">
      {tour.steps.map((step, i) => (
        <GuideStep key={step.id} n={i + 1} title={step.title} text={detail[step.id].text} action={detail[step.id].action} done={step.done} current={step.id === tour.current} />
      ))}
      {!health?.agent || idle ? (
        <p className="mt-2 border-t border-white/[0.075] pt-3 text-[12.5px] text-muted">
          {!health?.agent ? "No agent is connected to this server, so the agent steps are unavailable." : "An agent run is in flight, so the other buttons wait for it."}
        </p>
      ) : null}
    </ol>
  );
}
