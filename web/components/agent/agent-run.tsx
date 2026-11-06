"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiProblem, streamAgentRun } from "@/lib/client-api";
import type { AgentStreamEvent, Health } from "../../../src/server/wire";
import { Label } from "../ui";

type Result = { ok: boolean; kind: "refused" | "invalid" | "failed" | null; summary: string };
export type Step =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; tool: string; incident: string | null; detail: string | null; result: Result | null };

type Done = Extract<AgentStreamEvent, { type: "done" }>;

export interface AgentRunState {
  status: "idle" | "running" | "done" | "error";
  actor: string | null;
  mode: "commander" | "adversary";
  scope: string | null;
  steps: Step[];
  done: Done | null;
  error: string | null;
}

const IDLE: AgentRunState = { status: "idle", actor: null, mode: "commander", scope: null, steps: [], done: null, error: null };

/**
 * Who works agent runs on this server, as a sentence would name it. Offline without a key that is a deterministic
 * script, and the page says so rather than letting it pass for a model.
 */
export function agentName(agent: Health["agent"] | undefined, capital = false): string {
  if (agent?.kind === "model") return agent.name;
  if (agent?.kind === "scripted") return capital ? "The scripted agent" : "the scripted agent";
  return capital ? "The agent" : "the agent";
}

/** Folds one streamed event into the run state. Pure, so the timeline is a function of what the server said. */
export function reduce(state: AgentRunState, event: AgentStreamEvent): AgentRunState {
  switch (event.type) {
    case "start":
      return { ...IDLE, status: "running", actor: event.actor, scope: event.scope, mode: event.mode };
    case "text":
      return { ...state, steps: [...state.steps, { kind: "text", text: event.text }] };
    case "call":
      return { ...state, steps: [...state.steps, { kind: "tool", id: event.id, tool: event.tool, incident: event.incident, detail: event.detail, result: null }] };
    case "result":
      return {
        ...state,
        steps: state.steps.map((s) =>
          s.kind === "tool" && s.id === event.id ? { ...s, result: { ok: event.ok, kind: event.kind, summary: event.summary } } : s,
        ),
      };
    case "done":
      return { ...state, status: "done", done: event };
    case "error":
      return { ...state, status: "error", error: event.message };
  }
}

/** Shown when the server closed the stream without saying the run finished or failed. */
export const STREAM_ENDED_EARLY =
  "The stream ended early, before the agent said it was done. Whatever it completed is in the ledger; nothing else happened.";

/** Folds the end of the stream into the state: a run that never reported done or error did not succeed. */
export function settle(state: AgentRunState): AgentRunState {
  return state.status === "running" ? { ...state, status: "error", error: STREAM_ENDED_EARLY } : state;
}

type Mode = AgentRunState["mode"];

interface AgentRun {
  state: AgentRunState;
  /** The incident the running (or last) run was started for; null for the whole board. */
  target: string | null;
  running: boolean;
  start: (incidentId: string | null, mode?: Mode) => void;
  stop: () => void;
  /** Stops a running run and empties the timeline. Used when the demo is reset underneath it. */
  clear: () => void;
  /** Subscribes to "something changed": fired after each tool result and when the run ends. Returns the unsubscribe. */
  subscribe: (listener: () => void) => () => void;
}

const AgentRunContext = createContext<AgentRun | null>(null);

/**
 * Holds the one agent run for the whole app. It lives in the root layout, so moving between the board and an incident
 * page does not cancel a run; only "Stop" does. Only one run at a time: start() while running is ignored.
 */
export function AgentRunProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AgentRunState>(IDLE);
  const [target, setTarget] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const listeners = useRef(new Set<() => void>());

  const notify = useCallback(() => {
    for (const listener of listeners.current) listener();
  }, []);

  const start = useCallback(
    (incidentId: string | null, mode: Mode = "commander") => {
      if (controller.current) return;
      const abort = new AbortController();
      controller.current = abort;
      setTarget(incidentId);
      setState({ ...IDLE, status: "running", mode, scope: incidentId });
      void (async () => {
        try {
          await streamAgentRun(
            incidentId,
            (event) => {
              setState((current) => reduce(current, event));
              if (event.type === "result") notify();
            },
            abort.signal,
            mode,
          );
          setState(settle);
        } catch (error) {
          const message = abort.signal.aborted
            ? "Stopped. The server ends the run at its next step; whatever it completed is in the ledger."
            : error instanceof ApiProblem
              ? error.problem.message
              : error instanceof Error
                ? error.message
                : "The agent run failed.";
          setState((current) => (current.status === "running" ? { ...current, status: "error", error: message } : current));
        } finally {
          controller.current = null;
          notify();
        }
      })();
    },
    [notify],
  );

  const stop = useCallback(() => controller.current?.abort(), []);

  const clear = useCallback(() => {
    controller.current?.abort();
    setState(IDLE);
    setTarget(null);
  }, []);

  const subscribe = useCallback((listener: () => void) => {
    listeners.current.add(listener);
    return () => void listeners.current.delete(listener);
  }, []);

  const value = useMemo<AgentRun>(
    () => ({ state, target, running: state.status === "running", start, stop, clear, subscribe }),
    [state, target, start, stop, clear, subscribe],
  );
  return <AgentRunContext.Provider value={value}>{children}</AgentRunContext.Provider>;
}

/** The app's agent run. `onProgress` fires after each tool result and when the run ends, so a page can refetch. */
export function useAgentRun(onProgress?: () => void): AgentRun {
  const run = useContext(AgentRunContext);
  if (!run) throw new Error("useAgentRun needs <AgentRunProvider> in the root layout");
  const progress = useRef(onProgress);
  progress.current = onProgress;
  const { subscribe } = run;
  useEffect(() => subscribe(() => progress.current?.()), [subscribe]);
  return run;
}

/** The model sometimes reaches for markdown. The console shows plain text, so strip the markers rather than print them. */
const plain = (text: string): string => text.replace(/\*\*/g, "").replace(/`/g, "").replace(/^#+\s*/gm, "");

const toolLabel = (tool: string): string => {
  const words = tool.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

function ToolStep({ step }: { step: Extract<Step, { kind: "tool" }> }) {
  const { result } = step;
  return (
    <li className="px-5 py-3.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span aria-hidden className={`mt-1.5 size-2 shrink-0 self-start ${result ? (result.ok ? "bg-blue" : "bg-ink") : "beat bg-blue"}`} />
        <Label className="text-ink">{toolLabel(step.tool)}</Label>
        {step.incident ? <span className="font-mono text-[13px]">{step.incident}</span> : null}
      </div>
      {step.detail ? <p className="mt-1.5 pl-5 text-[13px] italic leading-relaxed text-muted">&ldquo;{step.detail}&rdquo;</p> : null}
      {result ? (
        result.kind === "refused" ? (
          <div role="alert" className="mt-2.5 ml-5 bg-ink px-4 py-3 text-paper">
            <Label className="text-paper">Refused by code</Label>
            <p className="mt-1.5 text-sm leading-relaxed">{result.summary}</p>
          </div>
        ) : result.ok ? (
          <p className="mt-1.5 pl-5 text-sm leading-relaxed text-muted">{result.summary}</p>
        ) : (
          <p className="mt-2.5 ml-5 border border-ink px-4 py-2.5 text-sm leading-relaxed">
            <Label className="mr-2 text-ink">Turned away</Label>
            {result.summary}
          </p>
        )
      ) : null}
    </li>
  );
}

/** What the agent said, each tool it reached for, and what the code answered. Refusals are the loudest thing on it. */
export function AgentTimeline({ state }: { state: AgentRunState }) {
  const [showAll, setShowAll] = useState(false);
  if (state.status === "idle") return null;
  const refused = state.done?.refused ?? state.steps.filter((s) => s.kind === "tool" && s.result?.kind === "refused").length;

  // Live, every step shows as it happens. Once the run is done the page is for reading the outcome: keep the agent's
  // closing report and everything the code refused or turned away, and fold the routine steps behind a toggle.
  const finished = state.status === "done";
  const lastText = state.steps.findLastIndex((s) => s.kind === "text");
  const visible = state.steps.flatMap((step, i) => {
    const keep = !finished || showAll || i === lastText || (step.kind === "tool" && step.result?.ok === false);
    return keep ? [{ step, i }] : [];
  });
  const folded = state.steps.length - visible.length;

  return (
    <div>
      <ol className="divide-y divide-rule">
        {visible.map(({ step, i }) =>
          step.kind === "text" ? (
            <li key={i} className="px-5 py-4">
              <p className="whitespace-pre-line border-l-2 border-blue pl-4 text-sm leading-relaxed">{plain(step.text)}</p>
            </li>
          ) : (
            <ToolStep key={step.id} step={step} />
          ),
        )}
        {state.status === "running" ? (
          <li className="flex items-center gap-3 px-5 py-4">
            <span aria-hidden className="beat size-2 bg-blue" />
            <Label>{state.steps.length === 0 ? "Starting" : "Thinking"}</Label>
          </li>
        ) : null}
      </ol>
      {finished && (folded > 0 || showAll) ? (
        <button
          type="button"
          aria-expanded={showAll}
          onClick={() => setShowAll((open) => !open)}
          className="label w-full cursor-pointer border-t border-rule px-5 py-3.5 text-left text-ink hover:text-blue"
        >
          {showAll ? "Hide routine steps" : `Show ${folded} routine step${folded === 1 ? "" : "s"}`}
        </button>
      ) : null}
      {state.error ? (
        <p role="alert" className="border-t border-ink bg-ink px-5 py-4 text-sm text-paper">
          {state.error}
        </p>
      ) : null}
      {state.done ? (
        <p className="tnum border-t border-rule px-5 py-3.5 text-[11px] font-medium uppercase tracking-[0.16em] text-muted">
          {state.done.calls} tool call{state.done.calls === 1 ? "" : "s"} &middot; {refused} refused by code &middot; {state.done.steps} model turn
          {state.done.steps === 1 ? "" : "s"}
          {state.done.stoppedBecause === "step_limit" ? " · stopped at the step limit" : ""}
          {state.done.stoppedBecause === "call_limit" ? " · stopped at the tool call limit" : ""}
          {state.done.stoppedBecause === "aborted" ? " · stopped early" : ""}
        </p>
      ) : null}
    </div>
  );
}
