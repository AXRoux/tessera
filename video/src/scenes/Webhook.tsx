import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { Shell } from "../Shell";
import { cue } from "../lib";
import { C, F } from "../theme";
import { Mono, Reveal, Sfx, Typed, useEnter } from "../ui";

const id = "webhook" as const;
const T = {
  hook: cue(id, "signed webhook"),
  reread: cue(id, "re-reads the transfer"),
  flip: cue(id, "from wait to replace"),
  wake: cue(id, "the agent wakes"),
  pay: cue(id, "pays the replacement"),
};

const NODES = [
  {
    at: T.hook,
    tag: "Airwallex",
    title: "Signed webhook",
    mono: "payout.transfer.cancelled",
    note: "Signature verified.",
    color: C.soft,
    dashed: true,
  },
  {
    at: T.reread,
    tag: "Tessera",
    title: "Re-reads the transfer",
    mono: "source of truth: Airwallex",
    note: "Does not trust the message.",
    color: C.blue,
    dashed: false,
  },
  {
    at: T.flip,
    tag: "Commander",
    title: "wait → replace",
    mono: "decision flipped",
    note: "Provably cancelled, within the automatic limit.",
    color: C.amber,
    dashed: false,
  },
  {
    at: T.wake,
    tag: "Agent",
    title: "Woken for this incident",
    mono: "replace_payment → attempt #2",
    note: "Same toolbox. Same rules. Same caps.",
    color: C.green,
    dashed: false,
  },
];

const NODE_W = 360;
const GAP = 100;

const Node: React.FC<{ i: number }> = ({ i }) => {
  const n = NODES[i]!;
  return (
    <Reveal at={n.at} y={30} style={{ position: "absolute", left: i * (NODE_W + GAP), top: 170, width: NODE_W }}>
      <div
        style={{
          height: 330,
          padding: 28,
          border: `3px ${n.dashed ? "dashed" : "solid"} ${n.color}`,
          background: "rgba(255,255,255,0.04)",
        }}
      >
        <Mono size={18} color={n.color}>
          {n.tag}
        </Mono>
        <div style={{ fontFamily: F.display, fontSize: 36, lineHeight: 1.15, marginTop: 20 }}>{n.title}</div>
        <div style={{ fontFamily: F.mono, fontSize: 17, color: n.color, marginTop: 20 }}>{n.mono}</div>
        <div style={{ fontSize: 25, color: C.muted, marginTop: 18, lineHeight: 1.3 }}>{n.note}</div>
      </div>
    </Reveal>
  );
};

const Link: React.FC<{ i: number }> = ({ i }) => {
  const frame = useCurrentFrame();
  const from = NODES[i]!.at;
  const to = NODES[i + 1]!.at;
  const p = interpolate(frame, [from + 10, to], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const left = i * (NODE_W + GAP) + NODE_W;
  return (
    <div style={{ position: "absolute", left, top: 335, width: GAP, height: 6 }}>
      <div style={{ position: "absolute", inset: 0, background: C.line }} />
      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: GAP * p, background: C.soft }} />
      {p > 0.02 ? (
        <div style={{ position: "absolute", left: GAP * p - 4, top: -9, width: 0, height: 0, borderLeft: `16px solid ${C.soft}`, borderTop: "12px solid transparent", borderBottom: "12px solid transparent" }} />
      ) : null}
    </div>
  );
};

export const Webhook: React.FC = () => {
  const head = useEnter(4);
  return (
    <Shell id={id} eyebrow="04 · The bank speaks first">
      <div style={{ position: "relative", width: 1740, height: 780 }}>
        <div style={{ opacity: head, transform: `translateY(${(1 - head) * 20}px)` }}>
          <div style={{ fontFamily: F.display, fontSize: 64 }}>
            Nobody pressed anything<span style={{ color: C.blue }}>.</span>
          </div>
        </div>
        {NODES.map((_, i) => (
          <Node key={i} i={i} />
        ))}
        {NODES.slice(0, -1).map((_, i) => (
          <Link key={i} i={i} />
        ))}
        <Reveal at={T.pay} y={20} style={{ position: "absolute", left: 0, top: 600, width: 1740 }}>
          <div
            style={{
              background: "#05060a",
              border: `2px solid ${C.line}`,
              padding: "26px 34px",
              fontFamily: F.mono,
              fontSize: 28,
              color: "#d8def5",
            }}
          >
            <span style={{ color: C.soft }}>board › </span>
            <Typed text="Webhook payout.transfer.cancelled · wait → replace the payment · agent woken" at={T.pay + 6} cps={48} />
          </div>
        </Reveal>
      </div>
      <Sfx id="alert" at={T.hook} volume={0.45} />
      <Sfx id="tick" at={T.reread} volume={0.5} />
      <Sfx id="impact" at={T.flip} volume={0.4} />
      <Sfx id="chime" at={T.wake} volume={0.45} />
      <Sfx id="keys" at={T.pay + 6} volume={0.4} />
    </Shell>
  );
};
