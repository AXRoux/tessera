"use client";

import Link from "next/link";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Health, IncidentSummary } from "../../../src/server/wire";
import { Acknowledged, api, ApiProblem } from "@/lib/client-api";
import { boardMoves, moveOf, type Move } from "@/lib/next-moves";
import { money } from "@/lib/format";
import { useAgentRun } from "../agent/agent-run";
import { AgentMark } from "../kit/agent-mark";
import { Icon } from "../landing/icons";
import { Btn, LinkBtn } from "../kit/metal";
import { Kicker, Tray } from "../kit/widgets";

/** At most this many keys; fewer when the strip is narrow (only whole keys are shown, the rest are counted). */
const KEYS = 6;

function Badge({ move, on }: { move: Move; on: boolean }) {
  const tone = move.who === "you" ? (on ? "bg-warn text-white" : "text-warn") : on ? "bg-accent text-white" : "text-accent";
  return (
    <span className={`flex size-8 shrink-0 items-center justify-center rounded-[10px] ${tone}`}>
      {move.who === "you" ? <Icon name="hand" className="size-4" /> : move.label === "Certify" ? <Icon name="check" className="size-[18px]" /> : <AgentMark size={18} />}
    </span>
  );
}

/** One invoice's next move as a key: raised and black when it is the one shown below, recessed otherwise. */
function Key({ move, on, onPick, hidden }: { move: Move; on: boolean; onPick: () => void; hidden: boolean }) {
  return (
    <li data-key className={`shrink-0 ${hidden ? "invisible" : ""}`} aria-hidden={hidden || undefined}>
      <button
        type="button"
        onClick={onPick}
        tabIndex={hidden ? -1 : undefined}
        aria-pressed={on}
        title={move.line}
        className={`flex h-11 cursor-pointer items-center gap-2.5 rounded-[14px]! pl-1.5 pr-3.5 text-left ${on ? "tile inverse text-fg" : "well hover:text-fg"}`}
      >
        <Badge move={move} on={on} />
        <span className="flex min-w-0 flex-col leading-tight">
          <span className={`readout text-[12px] font-medium ${on ? "" : "text-fg/80"}`}>{move.item.reference}</span>
          <span className={`text-[11px] ${on ? "text-fg/65" : "text-fg/45"}`}>{move.who === "you" ? `Yours · ${move.label}` : move.label}</span>
        </span>
      </button>
    </li>
  );
}

/**
 * The top of the control room: what to do next on your payouts, invoice by invoice. Each key is one invoice and the move
 * it is waiting for, most urgent first (yours, then the money, the supplier, certification); the line below says it in
 * a sentence and the button does exactly that, on that invoice only. Invoices with the bank, or certified, need nothing
 * and get no key.
 */
export function NextMoves({
  items,
  health,
  onCompose,
  onChanged,
  extras,
}: {
  items: IncidentSummary[];
  health: Health | null;
  onCompose: () => void;
  /** After a move made here (a certificate), so the board reads the change at once. */
  onChanged: () => void;
  extras?: ReactNode;
}) {
  const agent = useAgentRun();
  const reader = health ? health.reader !== null : true;
  const moves = boardMoves(items, { reader });
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const current = moves.find((m) => m.item.id === picked) ?? moves[0] ?? null;
  // Only whole keys: measure which fit the strip, and count the rest.
  const keyList = useRef<HTMLOListElement>(null);
  const [fit, setFit] = useState(KEYS);
  const shown = moves.slice(0, KEYS);
  const keySignature = shown.map((m) => `${m.item.id}:${m.label}`).join("|");
  useLayoutEffect(() => {
    const list = keyList.current;
    if (!list) return;
    const measure = () => {
      const right = list.getBoundingClientRect().right;
      const keys = [...list.querySelectorAll<HTMLElement>("li[data-key]")];
      const whole = keys.findIndex((key) => key.getBoundingClientRect().right > right + 0.5);
      setFit(whole === -1 ? keys.length : Math.max(1, whole));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [keySignature]);
  const hiddenCount = moves.length - Math.min(fit, shown.length);
  const agentReady = Boolean(health?.agent) && !agent.running;

  async function certify(move: Move) {
    setBusy(true);
    setSaid(null);
    try {
      await api(`obligations/${move.item.id}/close`, Acknowledged, { method: "POST" });
      setSaid({ tone: "ok", text: `${move.item.reference} is certified. The certificate is on its page.` });
      onChanged();
    } catch (error) {
      setSaid({ tone: "bad", text: error instanceof ApiProblem ? error.problem.message : `${move.item.reference} could not be certified just now.` });
    } finally {
      setBusy(false);
    }
  }

  const action = (() => {
    if (items.length === 0) return <Btn onClick={onCompose}>Send a payout</Btn>;
    if (!current) {
      return (
        <Btn tone="secondary" onClick={onCompose}>
          Send a payout
        </Btn>
      );
    }
    const { item } = current;
    if (current.who === "you") {
      const yours = (
        <LinkBtn
          tone={current.agentCan ? "secondary" : "primary"}
          href={current.label === "Read message" ? `/incidents/${item.id}` : `/queue?id=${item.id}`}
          icon={<Icon name="hand" className="size-4" />}
        >
          {current.label === "Send reply" ? "Read the reply" : current.label === "Read message" ? `Open ${item.reference}` : current.agentCan ? "Do it yourself" : `Decide on ${item.reference}`}
        </LinkBtn>
      );
      if (!current.agentCan) return yours;
      // Yours, but within what the agent may do too (a replacement inside the automatic limit, a funded one).
      return (
        <div className="flex items-center gap-2">
          {yours}
          <Btn disabled={!agentReady} busy={agent.running && agent.target === item.id} onClick={() => agent.start(item.id)} icon={<AgentMark size={18} />}>
            Let the agent {current.label.toLowerCase()} it
          </Btn>
        </div>
      );
    }
    if (current.label === "Certify") {
      return (
        <Btn busy={busy} onClick={() => void certify(current)} icon={<Icon name="check" className="size-4" />}>
          Certify {item.reference}
        </Btn>
      );
    }
    return (
      <Btn
        disabled={!agentReady}
        busy={agent.running && agent.target === item.id}
        onClick={() => agent.start(item.id)}
        icon={<AgentMark size={18} />}
        title={health?.agent ? `The agent works ${item.reference} only` : "No agent is connected"}
      >
        Let the agent do it
      </Btn>
    );
  })();

  // Nothing to move: say where everything is instead, in numbers that add up to the board.
  const resting = (() => {
    const all = items.map((item) => moveOf(item, { reader }));
    const count = (pred: (m: Move) => boolean) => all.filter(pred).length;
    const parts = [
      [count((m) => m.label === "With the bank"), "with the bank"],
      [count((m) => m.label === "Holding"), "paid and holding"],
      [count((m) => m.who === "done"), "certified"],
    ] as const;
    return parts.filter(([n]) => n > 0).map(([n, words]) => `${n} ${words}`).join(", ");
  })();

  const line = said
    ? said.text
    : items.length === 0
      ? "No payouts yet. Send one: Tessera seals it in the ledger before a cent moves."
      : current
        ? current.line
        : `Nothing to move. ${resting}.`;

  return (
    <Tray label="Next on your payouts" className="justify-center gap-2.5 px-3 py-3">
      <div className="flex min-w-0 items-center gap-3 px-1">
        <Kicker className="hidden shrink-0 sm:block">
          Next<span className="hidden 2xl:inline"> on your payouts</span>
        </Kicker>
        {moves.length > 0 ? (
          <>
            <ol ref={keyList} className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden" aria-label="Invoices waiting for a move, most urgent first">
              {shown.map((move, index) => (
                <Key
                  key={move.item.id}
                  move={move}
                  hidden={index >= fit}
                  on={move.item.id === current?.item.id}
                  onPick={() => {
                    setPicked(move.item.id);
                    setSaid(null);
                  }}
                />
              ))}
            </ol>
            {hiddenCount > 0 ? (
              <Link href="/queue" title="Every invoice waiting for a move" className="well readout flex h-11 shrink-0 items-center rounded-[14px]! px-3 text-[12px] text-fg/55 hover:text-fg">
                +{hiddenCount}
              </Link>
            ) : null}
          </>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg/45">{items.length === 0 ? "The ledger is empty." : "Every invoice is with the bank or certified."}</span>
        )}

        {extras ? <span className="hidden shrink-0 items-center gap-3 border-l border-fg/10 pl-3 sm:flex">{extras}</span> : null}
      </div>
      <div className="flex min-w-0 flex-col gap-3 px-1 sm:flex-row sm:items-center sm:gap-4">
        <p role={said ? (said.tone === "bad" ? "alert" : "status") : undefined} className={`min-w-0 flex-1 truncate text-[13px] leading-snug ${said?.tone === "bad" ? "text-bad" : "text-fg/70"}`} title={line}>
          {current && !said ? (
            <>
              <Link href={`/incidents/${current.item.id}`} className="readout font-medium text-accent hover:underline">
                {current.item.reference}
              </Link>
              <span className="text-fg/40"> · {money(current.item.amountMinor, current.item.currency)} · </span>
              {current.line}
            </>
          ) : (
            line
          )}
        </p>
        <div className="shrink-0">{action}</div>
      </div>
    </Tray>
  );
}
