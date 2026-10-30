import Link from "next/link";
import { summarizeRun } from "@/lib/run-summary";
import { Label } from "../ui";
import type { AgentRunState } from "./agent-run";

/**
 * "What the agent did": one row per incident the run touched, with what happened there in order. `idFor` maps the
 * reference the stream names to the incident's id so each row can link; a reference it cannot map stays plain text.
 */
export function RunReport({ state, idFor }: { state: AgentRunState; idFor: (reference: string) => string | undefined }) {
  if (state.status !== "done" && state.status !== "error") return null;
  const { headline, rows } = summarizeRun(state.steps, state.mode);
  if (state.status === "error" && state.steps.length === 0) return null;

  return (
    <div className="border-b border-rule px-5 py-5">
      <Label className="text-ink">What the agent did{state.status === "error" ? " before it stopped" : ""}</Label>
      <p role="status" aria-live="polite" className="mt-3 text-sm font-semibold">
        {headline}
      </p>
      {rows.length > 0 ? (
        <ul className="mt-4 divide-y divide-rule border-y border-rule">
          {rows.map((row) => {
            const id = idFor(row.reference);
            return (
              <li key={row.reference} className="flex flex-wrap items-center gap-x-5 gap-y-2 py-3">
                {id ? (
                  <Link href={`/incidents/${id}`} className="w-28 shrink-0 font-mono text-[13px] font-medium underline decoration-rule underline-offset-4 hover:text-blue">
                    {row.reference}
                  </Link>
                ) : (
                  <span className="w-28 shrink-0 font-mono text-[13px] font-medium">{row.reference}</span>
                )}
                <ul className="flex flex-wrap items-center gap-2">
                  {row.chips.map((chip) => (
                    <li
                      key={chip.label}
                      className={`inline-flex h-6 items-center px-2.5 text-[11px] font-medium uppercase tracking-[0.14em] ${chip.refused ? "bg-ink text-paper" : "border border-blue text-blue"}`}
                    >
                      {chip.label}
                      {chip.count > 1 ? <span className="tnum ml-1.5">&times;{chip.count}</span> : null}
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
