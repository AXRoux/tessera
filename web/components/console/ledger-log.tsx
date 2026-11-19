"use client";

import { useState, type ReactNode } from "react";
import { bandOf, BAND_STYLE } from "@/lib/activity";
import { actorLabel } from "@/lib/agent-verdict";
import { describeEvent, eventTitle } from "@/lib/describe-event";
import { ago, shortHash } from "@/lib/format";
import { initialsOf } from "@/lib/initials";
import type { IncidentView, SupplierBadge } from "../../../src/server/wire";
import { AgentMark } from "../kit/agent-mark";
import { Icon } from "../landing/icons";
import { SupplierMark } from "../suppliers/supplier-mark";

type Event = IncidentView["events"][number];
type IconName = Parameters<typeof Icon>[0]["name"];

/** Who did it: the agent, a person, the supplier, Airwallex (the bank and the card issuer), Visa, or Tessera itself. */
type Actor = { kind: "agent" | "person" | "supplier" | "airwallex" | "visa" | "tessera"; id: string };

const AIRWALLEX = new Set([
  "TRANSFER_STATUS", "WEBHOOK_RECEIVED", "FAILURE_RECORDED", "LATE_FAILURE", "UNKNOWN_STATUS", "STATUS_AFTER_DEAD", "TRANSFER_AFTER_ABANDON",
  "FUNDING_STATUS", "FUNDING_AMBIGUOUS", "FUNDING_MISMATCH", "FUNDING_AFTER_ABANDON", "CREATE_AMBIGUOUS", "TRANSFER_MISMATCH", "CARD_ISSUED", "CARD_STATUS",
]);
const SUPPLIER = new Set(["INBOX_RECEIVED", "REQUEST_RECEIVED"]);
const VISA = new Set(["CARD_CHARGE"]);

const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const field = (payload: unknown, key: string): string | null =>
  payload !== null && typeof payload === "object" ? str((payload as Record<string, unknown>)[key]) : null;

function actorOf(event: Event): Actor {
  const p = event.payload;
  if (event.type === "CASE_OPENED") return { kind: "tessera", id: "tessera" };
  if (event.type === "STORY_STEP") return field(p, "actor") === "bank" ? { kind: "airwallex", id: "airwallex" } : { kind: "supplier", id: "supplier" };
  if (SUPPLIER.has(event.type)) return { kind: "supplier", id: "supplier" };
  if (VISA.has(event.type)) return { kind: "visa", id: "visa" };
  if (AIRWALLEX.has(event.type)) return { kind: "airwallex", id: "airwallex" };
  // An escalation is the agent's when its reason carries the agent's prefix ("agent:x: why"); otherwise policy made it.
  if (event.type === "ESCALATED") {
    const reason = field(p, "reason") ?? "";
    return reason.startsWith("agent:") ? { kind: "agent", id: reason.split(":").slice(0, 2).join(":") } : { kind: "tessera", id: "tessera" };
  }
  const who = field(p, "actor") ?? field(p, "by") ?? field(p, "requestedBy") ?? field(p, "enteredBy") ?? field(p, "approvedBy");
  if (who && !["bank", "supplier"].includes(who)) return who.startsWith("agent:") ? { kind: "agent", id: who } : { kind: "person", id: who };
  return { kind: "tessera", id: "tessera" };
}

/** What happened, as the small badge on the avatar: an icon and its colour. */
function badgeOf(event: Event): { icon: IconName; tone: string } {
  const p = event.payload;
  switch (event.type) {
    case "PAYMENT_REFUSED":
    case "CARD_REFUSED":
      return { icon: "close", tone: "bg-bad" };
    case "CASE_OPENED":
      return { icon: "bolt", tone: "bg-bad" };
    case "AGENT_TOOL_CALL": {
      const outcome = field(p, "outcome");
      if (outcome && outcome !== "ok") return { icon: "close", tone: "bg-bad" };
      return field(p, "tool") === "escalate_to_human" ? { icon: "hand", tone: "bg-warn" } : { icon: "sparkle", tone: "bg-[#5b6172]" };
    }
    case "ESCALATED":
      return { icon: "hand", tone: "bg-warn" };
    case "ATTEMPT_INTENT":
    case "FUNDING_INTENT":
    case "CARD_ISSUE_INTENT":
    case "OBLIGATION_CREATED":
      return { icon: "lock", tone: "bg-[#5b6172]" };
    case "TRANSFER_STATUS": {
      const to = field(p, "to");
      if (to === "PAID") return { icon: "check", tone: "bg-accent" };
      if (to === "FAILED" || to === "CANCELLED") return { icon: "close", tone: "bg-bad" };
      return { icon: "bolt", tone: "bg-accent" };
    }
    case "FAILURE_RECORDED":
    case "LATE_FAILURE":
      return { icon: "close", tone: "bg-bad" };
    case "INBOX_RECEIVED":
    case "REQUEST_RECEIVED":
    case "STORY_STEP":
      return field(p, "actor") === "bank" ? { icon: "bolt", tone: "bg-accent" } : { icon: "mail", tone: "bg-accent" };
    case "CLOSED":
    case "CARD_SETTLED":
    case "REQUEST_APPROVED":
    case "CARD_DECIDED":
    case "ESCALATION_RESOLVED":
      return { icon: "check", tone: "bg-accent" };
    case "INCIDENT_REACTION":
    case "WEBHOOK_RECEIVED":
      return { icon: "activity", tone: "bg-[#5b6172]" };
    default:
      return event.type.startsWith("CARD_") ? { icon: "wallet", tone: "bg-[#5b6172]" } : { icon: "file", tone: "bg-[#5b6172]" };
  }
}

function Tile({ children, bg, className = "" }: { children?: ReactNode; bg: string; className?: string }) {
  return (
    <span className={`flex size-10 items-center justify-center overflow-hidden rounded-[12px] ${className}`} style={{ background: bg }}>
      {children}
    </span>
  );
}

/** A single-colour brand mark drawn through a mask, so it takes any colour. */
function Mask({ src, color, size }: { src: string; color: string; size: number }) {
  return <span aria-hidden style={{ width: size, height: size, background: color, mask: `url(${src}) center / contain no-repeat`, WebkitMask: `url(${src}) center / contain no-repeat` }} />;
}

function Avatar({ actor, supplier }: { actor: Actor; supplier: SupplierBadge | null }) {
  switch (actor.kind) {
    case "agent":
      return <AgentMark size={40} className="rounded-[12px]!" />;
    case "person":
      return (
        <span className="flex size-10 items-center justify-center rounded-full bg-fg text-[12.5px] font-semibold tracking-[0.02em] text-canvas">{initialsOf(actor.id)}</span>
      );
    case "supplier":
      return supplier ? (
        <SupplierMark supplier={supplier} size={40} />
      ) : (
        <Tile bg="color-mix(in oklab, var(--fg) 10%, transparent)">
          <Icon name="mail" className="size-5 text-fg/70" />
        </Tile>
      );
    case "airwallex":
      return (
        <Tile bg="#14100f">
          <Mask src="/brand/airwallex.svg" color="#ff6a3d" size={24} />
        </Tile>
      );
    case "visa":
      return (
        <Tile bg="#1a1f71">
          <Mask src="/brand/visa.svg" color="#ffffff" size={26} />
        </Tile>
      );
    case "tessera":
      return (
        <Tile bg="#ffffff" className="ring-1 ring-inset ring-black/10">
          {/* eslint-disable-next-line @next/next/no-img-element -- a fixed local mark */}
          <img src="/brand/tessera-mark-128.png" alt="" width={26} height={26} className="size-[26px]" />
        </Tile>
      );
  }
}

function nameOf(actor: Actor, supplier: SupplierBadge | null, operator: string | null): string {
  switch (actor.kind) {
    case "agent":
      return actorLabel(actor.id);
    case "person":
      return operator && actor.id === operator ? "You" : actor.id;
    case "supplier":
      return supplier?.name ?? "Supplier";
    case "airwallex":
      return "Airwallex";
    case "visa":
      return "Visa";
    case "tessera":
      return "Tessera";
  }
}

/** What an agent did, said as the line beside its name; refusals say so. */
const TOOL_VERB: Record<string, string> = {
  list_incidents: "read the board",
  assess_incident: "checked what policy allows",
  read_supplier_message: "read the supplier's message",
  replace_payment: "replaced the payment",
  fund_replacement: "funded the replacement",
  pay_invoice_by_card: "paid by Visa card",
  escalate_to_human: "handed it over",
  defer_incident: "chose to wait",
  draft_supplier_reply: "drafted a reply",
  reconcile_and_close: "certified it",
  request_virtual_card: "asked for a card",
};

function verbOf(event: Event): string {
  if (event.type === "AGENT_TOOL_CALL") {
    const tool = field(event.payload, "tool") ?? "";
    const outcome = field(event.payload, "outcome");
    if (outcome && outcome !== "ok") return "was refused by policy";
    return TOOL_VERB[tool] ?? tool.replaceAll("_", " ");
  }
  return eventTitle(event.type).toLowerCase();
}

const clockOf = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** "Today · 10 AM", "Yesterday · 9 PM", "Nov 17 · 7 PM": the hour an entry belongs to. */
function hourOf(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const hour = d.toLocaleTimeString([], { hour: "numeric" });
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const label = day === today ? "Today" : day === today - 86_400_000 ? "Yesterday" : d.toLocaleDateString([], { month: "short", day: "numeric" });
  return `${label} · ${hour}`;
}

function Row({ event, supplier, operator, last }: { event: Event; supplier: SupplierBadge | null; operator: string | null; last: boolean }) {
  const [open, setOpen] = useState(false);
  const actor = actorOf(event);
  const badge = badgeOf(event);
  const description = describeEvent(event.type, event.payload);
  return (
    <li className="relative">
      {/* The rail that joins one avatar to the next. */}
      {!last ? <span aria-hidden className="absolute bottom-0 left-[31px] top-[52px] w-px bg-fg/[0.12]" /> : null}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`flex w-full cursor-pointer items-start gap-3.5 rounded-[18px] px-3 py-2.5 text-left transition-colors hover:bg-fg/[0.045] ${open ? "bg-fg/[0.045]" : ""}`}
      >
        <span className="relative mt-0.5 shrink-0">
          <Avatar actor={actor} supplier={supplier} />
          <span aria-hidden className={`absolute -bottom-1 -left-1 flex size-[18px] items-center justify-center rounded-full text-white ring-2 ring-[var(--canvas)] ${badge.tone}`}>
            <Icon name={badge.icon} className="size-2.5" />
          </span>
          <span aria-hidden className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-[var(--canvas)]" style={{ background: BAND_STYLE[bandOf(event.type)].color }} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-3">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="truncate text-[15px] font-semibold tracking-[-0.01em]">{nameOf(actor, supplier, operator)}</span>
              <span className="truncate text-[13.5px] text-fg/50">{verbOf(event)}</span>
            </span>
            <span suppressHydrationWarning className="shrink-0 text-[13px] tabular-nums text-fg/50" title={`${event.ts} · ${ago(event.ts)}`}>
              {clockOf(event.ts)}
            </span>
          </span>
          <span className={`mt-0.5 block text-[14px] leading-relaxed text-fg/70 ${open ? "" : "line-clamp-2"}`}>{description}</span>
          {open ? (
            <span className="readout mt-1.5 block text-[11.5px] text-fg/40">
              #{event.seq} · sealed {shortHash(event.hash, 12)}
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

/**
 * The incident's history as an activity feed, newest first: who acted (the agent, a person, the supplier, Airwallex,
 * Visa, or Tessera), what they did, and when, grouped by the hour. Every entry is sealed to the one before it; open an
 * entry for its full text, its place in the chain and its fingerprint.
 */
export function LedgerLog({ events, chain, supplier = null, operator = null }: { events: IncidentView["events"]; chain: IncidentView["chain"]; supplier?: SupplierBadge | null; operator?: string | null }) {
  const newest = events.toReversed();
  const groups: { label: string; items: Event[] }[] = [];
  for (const event of newest) {
    const label = hourOf(event.ts);
    const group = groups.at(-1);
    if (group && group.label === label) group.items.push(event);
    else groups.push({ label, items: [event] });
  }
  return (
    <div className="space-y-3">
      <p className={`well flex items-center gap-2.5 rounded-full! px-4 py-2.5 text-[13.5px] ${chain.ok ? "text-fg/70" : "text-bad"}`}>
        <Icon name="shield" className={`size-4 shrink-0 ${chain.ok ? "text-accent" : "text-bad"}`} />
        {chain.ok ? "Every entry is sealed to the one before it. Change one and the chain breaks." : `The chain breaks at entry ${chain.brokenAt}: something was changed after it was written.`}
      </p>
      {groups.map((group) => (
        <section key={group.label}>
          <h3 suppressHydrationWarning className="px-3 pb-1 pt-2 text-[12.5px] font-semibold tracking-[0.01em] text-fg/45">
            {group.label}
          </h3>
          <ol>
            {group.items.map((event, i) => (
              <Row key={event.seq} event={event} supplier={supplier} operator={operator} last={i === group.items.length - 1} />
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
