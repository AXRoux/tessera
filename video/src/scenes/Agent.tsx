import React from "react";
import { useCurrentFrame } from "remotion";
import { Shell } from "../Shell";
import { cue, LEAD } from "../lib";
import { C, F } from "../theme";
import { Mono, Pill, Reveal, Sfx, Typed } from "../ui";

const id = "agent" as const;
const T = {
  assess: cue(id, "assesses every one"),
  replace: cue(id, "replaces the transient failure"),
  escalate: cue(id, "escalates the possible duplicate"),
  bank: cue(id, "and the bank change"),
  draft: cue(id, "drafts replies"),
  certify: cue(id, "certifies the paid one"),
  fund: cue(id, "claude converted exactly"),
};

type Row = { id: string; what: string; verdict: string; kind: "wait" | "ok" | "hand" | "blue"; at: number };
const ROWS: Row[] = [
  { id: "ACME-1041", what: "In flight, supplier says nothing arrived", verdict: "Deferred · reply drafted", kind: "wait", at: T.draft + 14 },
  { id: "ACME-1042", what: "Bank timeout, funds returned", verdict: "Replaced", kind: "ok", at: T.replace },
  { id: "ACME-1043", what: "Possible duplicate (91301)", verdict: "Escalated", kind: "hand", at: T.escalate },
  { id: "ACME-1044", what: "“We changed banks” email", verdict: "Escalated", kind: "hand", at: T.bank },
  { id: "ACME-1045", what: "Paid, hold window passed", verdict: "Certified", kind: "ok", at: T.certify },
  { id: "ACME-1046", what: "Paid, supplier says nothing arrived", verdict: "Reply drafted", kind: "blue", at: T.draft },
  { id: "ACME-1047", what: "EUR wallet short by €26.74", verdict: "Funded, then replaced", kind: "ok", at: T.fund },
];

const KIND: Record<Row["kind"], { bg: string; fg: string; border: string }> = {
  wait: { bg: "transparent", fg: "#fff", border: "#fff" },
  ok: { bg: C.green, fg: C.ink, border: C.green },
  hand: { bg: "#fff", fg: C.ink, border: "#fff" },
  blue: { bg: C.blue, fg: "#fff", border: C.blue },
};

// Tool calls from the recorded sandbox run (docs/img/terminal-agent.png), plus the funding step of the 2026-11-06 run.
const LINES: { at: number; text: string; tone?: "dim" | "ok" }[] = [
  { at: LEAD + 6, text: "$ bun run agent", tone: "dim" },
  { at: LEAD + 24, text: "→ list_incidents" },
  { at: LEAD + 40, text: "→ read_supplier_message ACME-1044" },
  { at: T.assess, text: "→ assess_incident ACME-1045" },
  { at: T.assess + 18, text: "→ assess_incident ACME-1042" },
  { at: T.replace, text: "→ replace_payment ACME-1042" },
  { at: T.escalate, text: '→ escalate_to_human ACME-1043 "possible duplicate"' },
  { at: T.bank, text: '→ escalate_to_human ACME-1044 "bank-detail change"' },
  { at: T.draft, text: "→ draft_supplier_reply ACME-1046 kind=PROOF" },
  { at: T.certify, text: "→ reconcile_and_close ACME-1045" },
  { at: T.fund, text: "→ fund_replacement ACME-1047 convert €26.74" },
  { at: T.fund + 40, text: "→ replace_payment ACME-1047" },
];

const Terminal: React.FC = () => {
  const frame = useCurrentFrame();
  const visible = LINES.filter((l) => frame >= l.at);
  const shown = visible.slice(-7);
  return (
    <div
      style={{
        width: 860,
        height: 780,
        background: "#05060a",
        border: `2px solid ${C.line}`,
        borderRadius: 16,
        overflow: "hidden",
        boxShadow: "0 30px 80px rgba(0,0,0,0.6)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "18px 22px", borderBottom: `1px solid ${C.line}` }}>
        {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
          <div key={c} style={{ width: 14, height: 14, borderRadius: 7, background: c }} />
        ))}
        <div style={{ fontFamily: F.mono, fontSize: 18, color: C.muted, marginLeft: 12 }}>agent · real Claude · Airwallex sandbox</div>
      </div>
      <div style={{ padding: "26px 28px", fontFamily: F.mono, fontSize: 25, lineHeight: 1.45 }}>
        {shown.map((l) => {
          const age = frame - l.at;
          const isLast = l === visible[visible.length - 1];
          return (
            <div key={l.at + l.text} style={{ marginBottom: 18, opacity: Math.min(1, age / 6) }}>
              <div style={{ color: l.tone === "dim" ? C.muted : "#e8ecff" }}>
                {isLast ? <Typed text={l.text} at={l.at} cps={70} cursor={false} /> : l.text}
              </div>
              {l.tone === "dim" ? null : (
                <div style={{ color: C.green, fontSize: 21, opacity: age > 14 ? 1 : 0 }}>✓ ok</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const Item: React.FC<{ r: Row }> = ({ r }) => {
  const frame = useCurrentFrame();
  const done = frame >= r.at;
  const k = KIND[r.kind];
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        height: 100,
        padding: "0 26px",
        borderBottom: `1px solid ${C.line}`,
        background: done ? "rgba(255,255,255,0.05)" : "transparent",
      }}
    >
      <div style={{ opacity: done ? 1 : 0.55 }}>
        <div style={{ fontFamily: F.mono, fontSize: 24, fontWeight: 700 }}>{r.id}</div>
        <div style={{ fontSize: 23, color: C.muted, marginTop: 4 }}>{r.what}</div>
      </div>
      {done ? (
        <Reveal at={r.at} x={30} y={0}>
          <Pill bg={k.bg} fg={k.fg} border={k.border} size={19}>
            {r.verdict}
          </Pill>
        </Reveal>
      ) : (
        <Mono size={16} color={C.muted}>
          open
        </Mono>
      )}
    </div>
  );
};

export const Agent: React.FC = () => (
  <Shell id={id} eyebrow="05 · The agent works">
    <div style={{ display: "flex", gap: 40 }}>
      <Reveal at={6} y={30}>
        <Terminal />
      </Reveal>
      <Reveal at={14} y={30} style={{ flex: 1 }}>
        <div style={{ height: 780, border: `2px solid ${C.line}`, background: "rgba(255,255,255,0.03)" }}>
          <div style={{ padding: "22px 26px 16px", borderBottom: `1px solid ${C.line}`, display: "flex", justifyContent: "space-between" }}>
            <Mono size={20} color={C.soft}>
              Seven incidents
            </Mono>
            <Mono size={18}>What the agent did</Mono>
          </div>
          {ROWS.map((r) => (
            <Item key={r.id} r={r} />
          ))}
        </div>
      </Reveal>
    </div>
    <Sfx id="keys" at={LEAD + 6} volume={0.35} />
    <Sfx id="chime" at={T.replace} volume={0.4} />
    <Sfx id="tick" at={T.escalate} volume={0.5} />
    <Sfx id="tick" at={T.bank} volume={0.5} />
    <Sfx id="tick" at={T.draft} volume={0.5} />
    <Sfx id="chime" at={T.certify} volume={0.45} />
    <Sfx id="impact" at={T.fund} volume={0.4} />
  </Shell>
);
