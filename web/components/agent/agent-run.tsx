"use client";

import Link from "next/link";
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
  /** One invoice, a chosen set (the board's plan), or null for every open one. */
  start: (incidentId: string | string[] | null, mode?: Mode) => void;
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
    (incidentId: string | string[] | null, mode: Mode = "commander") => {
      if (controller.current) return;
      const abort = new AbortController();
      controller.current = abort;
      // A run over one invoice is that invoice's; a run over a set belongs to the board.
      const one = Array.isArray(incidentId) ? (incidentId.length === 1 ? incidentId[0]! : null) : incidentId;
      setTarget(one);
      setState({ ...IDLE, status: "running", mode, scope: one });
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

/** What each tool is, in the words an operator watching would use. The name alone means little on a screen. */
const ACTION: Record<string, string> = {
  list_incidents: "Read the board",
  assess_incident: "Ask the code what is safe",
  read_supplier_message: "Read the supplier's message",
  replace_payment: "Ask to replace the payment",
  fund_replacement: "Ask to fund the replacement",
  draft_supplier_reply: "Draft a reply for a person",
  defer_incident: "Decide to wait",
  escalate_to_human: "Hand it to a person",
  reconcile_and_close: "Ask to certify",
  verify_ledger: "Check the history",
};
export const actionLabel = (tool: string): string => ACTION[tool] ?? tool.replaceAll("_", " ").replace(/^\w/, (c) => c.toUpperCase());

/** The tools whose success means a person now has to do something. */
const HANDOFF: Record<string, string> = {
  escalate_to_human: "This one is yours now. Nothing moves until you decide.",
  draft_supplier_reply: "A reply is drafted. Read it, then send it from your own mail.",
};

/** The reference a result names, so a handoff can link to the incident it belongs to. */
const referenceIn = (summary: string): string | null => /\b([A-Z]{2,}-\d{3,}(?:-[A-Z0-9]{2,})?)\b/.exec(summary)?.[1] ?? null;

/** Dense rendering for narrow panels; set by the timeline and read by every row in it. */
const DenseContext = createContext(false);

/** A vertical spine, a numbered disc per step, and the step itself. The spine is what makes the order readable at a glance. */
function StepRow({ n, tone, children }: { n: number; tone: "ok" | "bad" | "live"; result?: "ok" | "bad" | "live" | null; children: ReactNode }) {
  const dense = useContext(DenseContext);
  return (
    <li className={`flex ${dense ? "gap-3" : "gap-4 sm:gap-5"}`}>
      <div className={`flex shrink-0 flex-col items-center ${dense ? "w-7" : "w-9"}`}>
        <span
          className={`tnum flex items-center justify-center rounded-full border ${dense ? "size-7 text-[11px]" : "size-9 text-[13px]"} ${
            tone === "bad"
              ? "border-bad/60 bg-bad/15 font-medium text-bad"
              : tone === "live"
                ? "beat border-accent/60 bg-accent/10 text-fg"
                : "border-fg/20 bg-fg/[0.04] text-fg/80"
          }`}
        >
          {n}
        </span>
        <span aria-hidden className="mt-1.5 w-px flex-1 bg-fg/10" />
      </div>
      <div className={`min-w-0 flex-1 ${dense ? "pb-4" : "pb-7"}`}>{children}</div>
    </li>
  );
}

function ToolStep({ step, n, href }: { step: Extract<Step, { kind: "tool" }>; n: number; href: string | null }) {
  const { result } = step;
  const dense = useContext(DenseContext);
  const handoff = result?.ok ? HANDOFF[step.tool] : undefined;
  const reference = handoff ? (step.incident ?? referenceIn(result?.summary ?? "")) : null;
  return (
    <StepRow n={n} tone={result ? (result.ok ? "ok" : result.kind === "refused" ? "bad" : "bad") : "live"} result={result ? (result.ok ? "ok" : "bad") : "live"}>
      <p className={`font-medium tracking-[-0.01em] text-fg ${dense ? "pt-1 text-[13.5px]" : "pt-1.5 text-[15px]"}`}>{actionLabel(step.tool)}</p>
      {step.incident ? <p className="mt-1 font-mono text-[12.5px] text-fg/55">{step.incident}</p> : null}
      {step.detail ? (
        <p className={`mt-2 border-l-2 border-fg/15 pl-3 italic leading-relaxed text-fg/55 ${dense ? "line-clamp-2 text-[12px]" : "text-[13px]"}`} title={step.detail}>&ldquo;{step.detail}&rdquo;</p>
      ) : null}
      {result ? (
        result.kind === "refused" ? (
          <div role="alert" className={`rounded-xl border border-bad/40 bg-bad/10 ${dense ? "mt-1.5 px-3 py-2" : "mt-3 px-4 py-3"}`}>
            <Label className={`font-medium text-bad ${dense ? "text-[11px]" : ""}`}>Refused by code</Label>
            <p className={`leading-relaxed ${dense ? "mt-0.5 line-clamp-2 text-[12px] text-fg/75" : "mt-1.5 text-sm"}`} title={result.summary}>
              {result.summary}
            </p>
          </div>
        ) : result.ok ? (
          <p className={`border-l-2 border-accent/40 pl-3 leading-relaxed text-fg/80 ${dense ? "mt-2 text-[12.5px]" : "mt-3 text-sm"}`}>{result.summary}</p>
        ) : (
          <div className={`rounded-xl border border-fg/20 ${dense ? "mt-1.5 px-3 py-2" : "mt-3 px-4 py-3"}`}>
            <Label className={`font-medium text-fg ${dense ? "text-[11px]" : ""}`}>Turned away</Label>
            <p className={`leading-relaxed ${dense ? "mt-0.5 line-clamp-2 text-[12px] text-fg/75" : "mt-1.5 text-sm"}`} title={result.summary}>
              {result.summary}
            </p>
          </div>
        )
      ) : (
        <p className="mt-3 text-[13px] text-fg/55">Awaiting the code’s answer…</p>
      )}
      {handoff && result?.ok ? (
        <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-accent/45 bg-accent/10 ${dense ? "mt-2 px-3 py-2" : "mt-3 gap-x-4 gap-y-2 px-4 py-3"}`}>
          <span className={`font-medium text-accent ${dense ? "text-[12px]" : "text-[13px]"}`}>Your turn</span>
          <span className={`leading-relaxed text-fg/80 ${dense ? "text-[12px]" : "text-[13px]"}`}>{handoff}</span>
          {reference && href ? (
            <Link href={href} className={`text-fg/80 underline decoration-fg/30 underline-offset-4 hover:text-fg ${dense ? "text-[12px]" : "text-[13px]"}`}>
              Open {reference}
            </Link>
          ) : null}
        </div>
      ) : null}
    </StepRow>
  );
}

/** What the agent said, each tool it reached for, and what the code answered. A vertical spine, refusals in red, handoffs in blue. */
/** `idFor` maps the reference a step names to its incident id, so a handoff can be opened from here. */
export function AgentTimeline({
  state,
  idFor = () => undefined,
  dense = false,
  className = "max-h-[620px] px-5 py-5 sm:px-6",
}: {
  state: AgentRunState;
  idFor?: (reference: string) => string | undefined;
  /** Smaller discs and type, for a narrow column. */
  dense?: boolean;
  /** The scroll container's sizing; the dashboard lets it fill its panel instead of capping it. */
  className?: string;
}) {
  const [showAll, setShowAll] = useState(false);
  if (state.status === "idle") return null;
  const refused = state.done?.refused ?? state.steps.filter((s) => s.kind === "tool" && s.result?.kind === "refused").length;
  const calls = state.steps.filter((s) => s.kind === "tool").length;

  // Live, every step shows as it happens. Once the run ends, the outcome matters more than the routine: fold the
  // calls that simply worked, and keep everything the code refused, the agent's closing report, and every handoff.
  const finished = state.status === "done";
  const lastText = state.steps.findLastIndex((s) => s.kind === "text");
  const visible = state.steps.flatMap((step, i) => {
    // Everything the code refused, every handoff to a person, and the agent's closing report survive the fold.
    const matters = step.kind === "tool" && (step.result?.ok === false || (step.result?.ok === true && step.tool in HANDOFF));
    const keep = !finished || showAll || i === lastText || matters;
    return keep ? [{ step, i }] : [];
  });
  const folded = state.steps.length - visible.length;

  return (
    <DenseContext.Provider value={dense}>
    <div className={`thin-scroll overflow-y-auto overscroll-contain ${className}`}>
      <ol>
        {visible.map(({ step, i }, position) =>
          step.kind === "text" ? (
            <StepRow key={i} n={position + 1} tone="ok" result={null}>
              <p className={`whitespace-pre-line rounded-xl border border-fg/[0.08] bg-fg/[0.03] leading-relaxed ${dense ? "px-3 py-2.5 text-[12.5px]" : "px-4 py-3 text-[14px]"}`}>{plain(step.text)}</p>
            </StepRow>
          ) : (
            <ToolStep key={step.id} step={step} n={position + 1} href={step.incident ? (idFor(step.incident) ? `/incidents/${idFor(step.incident)}` : null) : null} />
          ),
        )}
        {state.status === "running" ? (
          <StepRow n={visible.length + 1} tone="live" result="live">
            <p className={`flex items-center gap-3 text-fg/80 ${dense ? "pt-1 text-[13px]" : "pt-1.5 text-[15px]"}`}>
              <span aria-hidden className="beat size-2 rounded-full bg-accent" />
              {state.steps.length === 0 ? "Reading the board…" : "Thinking…"}
            </p>
          </StepRow>
        ) : null}
      </ol>
      {finished && (folded > 0 || showAll) ? (
        <button
          type="button"
          aria-expanded={showAll}
          onClick={() => setShowAll((open) => !open)}
          className="mt-1 w-full cursor-pointer rounded-full border border-fg/15 px-4 py-2 text-[13px] text-fg/80 transition-colors hover:bg-fg/5"
        >
          {showAll ? `Show only what mattered` : `Show all ${calls} steps`}
        </button>
      ) : null}
      {state.error ? (
        <p role="alert" className="mt-4 rounded-xl border border-bad/50 bg-bad/10 px-4 py-3 text-sm text-bad">
          {state.error}
        </p>
      ) : null}
      {state.done ? (
        <p className="tnum mt-4 border-t border-fg/10 pt-4 text-[13px] text-fg/55">
          {state.done.calls} tool call{state.done.calls === 1 ? "" : "s"} &middot; {refused} refused by code &middot; {state.done.steps} model turn
          {state.done.steps === 1 ? "" : "s"}
          {state.done.stoppedBecause === "step_limit" ? " · stopped at the step limit" : ""}
          {state.done.stoppedBecause === "call_limit" ? " · stopped at the tool call limit" : ""}
          {state.done.stoppedBecause === "aborted" ? " · stopped early" : ""}
        </p>
      ) : null}
    </div>
    </DenseContext.Provider>
  );
}
