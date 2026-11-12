import Link from "next/link";
import type { IncidentSummary } from "../../src/server/wire";
import { actorLabel, agentVerdict } from "@/lib/agent-verdict";
import { ACTION_WORDS } from "@/lib/describe-event";
import { ago, money } from "@/lib/format";
import { ATTEMPT, describeFailure, SQUARE, STATUS } from "@/lib/status";
import { Tag } from "./ui";

/** Earlier attempts must have ended (they were replaced), so only the latest one can still be moving. */
function AttemptSquares({ item }: { item: IncidentSummary }) {
  const earlier = Math.max(0, item.attemptCount - 1);
  return (
    <span className="inline-flex items-center gap-1.5" aria-label={`${item.attemptCount} attempt${item.attemptCount === 1 ? "" : "s"}`}>
      {Array.from({ length: earlier }, (_, i) => (
        <span key={i} className="size-2.5 rounded-full bg-white/70" />
      ))}
      {item.latest ? <span className={`size-2.5 rounded-full ${SQUARE[item.latest.state]}`} /> : <span className="size-2.5 rounded-full border border-white/25" />}
    </span>
  );
}

/** The agent's latest verdict on the incident, in words. A refusal is as loud here as in the transcript. */
function VerdictLine({ item }: { item: IncidentSummary }) {
  const action = item.lastAgentAction;
  if (!action) return null;
  const verdict = agentVerdict(action);
  return (
    <p className="mt-1.5 text-[12px] leading-snug text-muted">
      <span className={verdict.refused ? "rounded bg-danger/15 px-1.5 py-0.5 font-medium text-danger [box-decoration-break:clone]" : "font-medium text-soft"}>{verdict.label}</span>{" "}
      <span suppressHydrationWarning>&middot; {actorLabel(action.actor)} &middot; {ago(action.at)}</span>
    </p>
  );
}

/** Tessera's latest reaction to a bank-side change: which Airwallex event made it look, and what changed. */
function ReactionLine({ item }: { item: IncidentSummary }) {
  const reaction = item.lastReaction;
  if (!reaction || reaction.source === "setup") return null;
  const cause = reaction.source === "webhook" ? `Webhook ${reaction.eventName ?? "from Airwallex"}` : "Seen by the sweep";
  const change =
    reaction.before !== reaction.after
      ? `${ACTION_WORDS[reaction.before] ?? reaction.before} → ${ACTION_WORDS[reaction.after] ?? reaction.after}`
      : `still ${ACTION_WORDS[reaction.after] ?? reaction.after}`;
  const woke = reaction.woke === "started" ? " · agent woken" : reaction.woke ? ` · agent ${reaction.woke}` : "";
  return (
    <p className="mt-1 text-[11.5px] leading-snug text-muted">
      <span className="font-mono">{cause}</span>
      <span suppressHydrationWarning>
        {" "}
        &middot; {change}
        {woke} &middot; {ago(reaction.at)}
      </span>
    </p>
  );
}

function FailureCell({ item }: { item: IncidentSummary }) {
  if (!item.latest) return <span className="text-muted">None</span>;
  if (!item.latest.failureCode) return <span className="text-muted">{ATTEMPT[item.latest.state].label}</span>;
  const failure = describeFailure(item.latest.failureCode);
  return (
    <span className="block leading-snug">
      <span className="block text-[13px]">{failure.name}</span>
      <span className="block text-[11px] text-muted">{failure.playbook}</span>
    </span>
  );
}

const HEADS = ["Invoice", "Amount", "Status", "Attempts", "Latest failure", "Updated"];

/** Every incident on the board. Rows link to the incident page; the whole row is the target, not just the reference. */
export function IncidentTable({ items, empty }: { items: IncidentSummary[]; empty: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[860px] border-collapse text-left">
        <thead>
          <tr className="border-b border-white/[0.075]">
            {HEADS.map((head) => (
              <th key={head} scope="col" className="label h-11 px-6 text-left font-normal first:pl-7 last:pr-7">
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr>
              <td colSpan={HEADS.length} className="px-7 py-12 text-center text-[14px] text-muted">
                {empty}
              </td>
            </tr>
          ) : (
            items.map((item) => {
              const status = STATUS[item.status];
              return (
                <tr key={item.id} className="group relative border-b border-white/[0.06] last:border-b-0 hover:bg-white/[0.03]">
                  <td className="relative px-6 py-4 pl-7">
                    <Link href={`/incidents/${item.id}`} className="font-mono text-[13px] after:absolute after:inset-0">
                      {item.reference}
                    </Link>
                    <p className="mt-1 text-[11px] text-muted">{item.method}</p>
                  </td>
                  <td className="tnum px-6 text-[15px] font-medium">{money(item.amountMinor, item.currency)}</td>
                  <td className="px-6 py-3">
                    <Tag tone={status.tone} pulse={status.pulse}>
                      {status.label}
                    </Tag>
                    <VerdictLine item={item} />
                    <ReactionLine item={item} />
                  </td>
                  <td className="px-6">
                    <AttemptSquares item={item} />
                  </td>
                  <td className="px-6 py-3">
                    <FailureCell item={item} />
                  </td>
                  <td suppressHydrationWarning className="px-6 text-[13px] text-muted last:pr-7">
                    {ago(item.updatedAt)}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
