"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiProblem, streamAgentRun } from "@/lib/client-api";
import type { AgentStreamEvent } from "../../../src/server/wire";
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

/** Runs the agent on the server and mirrors its steps. `onProgress` fires after each tool result so the page can refetch. */
export function useAgentRun(onProgress?: () => void) {
  const [state, setState] = useState<AgentRunState>(IDLE);
  const abort = useRef<AbortController | null>(null);
  const progress = useRef(onProgress);
  progress.current = onProgress;

  const start = useCallback(async (incidentId: string | null, mode: "commander" | "adversary" = "commander"): Promise<void> => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setState({ ...IDLE, status: "running", mode });
    try {
      await streamAgentRun(
        incidentId,
        (event) => {
          setState((current) => reduce(current, event));
          if (event.type === "result") progress.current?.();
        },
        controller.signal,
        mode,
      );
      setState((current) => (current.status === "running" ? { ...current, status: "done" } : current));
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof ApiProblem ? error.problem.message : error instanceof Error ? error.message : "The agent run failed.";
      setState((current) => ({ ...current, status: "error", error: message }));
    }
  }, []);

  // Leaving the page cancels the fetch; the proxy forwards that and the server stops the agent at its next step.
  useEffect(() => () => abort.current?.abort(), []);

  return { state, start };
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
  if (state.status === "idle") return null;
  const refused = state.done?.refused ?? state.steps.filter((s) => s.kind === "tool" && s.result?.kind === "refused").length;
  return (
    <div>
      <ol className="divide-y divide-rule">
        {state.steps.map((step, i) =>
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
          {state.done.stoppedBecause === "aborted" ? " · stopped early" : ""}
        </p>
      ) : null}
    </div>
  );
}
