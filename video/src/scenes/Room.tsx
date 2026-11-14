import React from "react";
import { useCurrentFrame } from "remotion";
import { Shell } from "../Shell";
import { cue, sceneFrames } from "../lib";
import { C } from "../theme";
import { Camera, Mono, Reveal, Sfx } from "../ui";

const id = "room" as const;
const T = {
  room: cue(id, "control room"),
  seven: cue(id, "seven supplier payouts"),
  trouble: cue(id, "different kind of trouble"),
  move: cue(id, "next safe move"),
  waiting: cue(id, "waiting on you"),
  agent: cue(id, "the agent will work"),
};
const END = sceneFrames(id);

// The real console, captured at 2x (3200 x 2000) from the offline demo with the seven seeded incidents.
const IMG = { src: "img/v2/board.jpg", imgW: 3200, imgH: 2000 };

const LABELS = [
  { at: T.seven, text: "Seven payouts, seven kinds of trouble" },
  { at: T.move, text: "The next safe move, per invoice" },
  { at: T.waiting, text: "What the agent would not decide alone" },
  { at: T.agent, text: "What the agent will work, and why" },
];

const Label: React.FC = () => {
  const frame = useCurrentFrame();
  const current = [...LABELS].reverse().find((l) => frame >= l.at + 24);
  if (!current) return null;
  return (
    <Reveal key={current.at} at={current.at + 24} y={14} style={{ position: "absolute", left: 28, bottom: 26 }}>
      <div style={{ background: "rgba(11,13,18,0.86)", border: `1px solid ${C.line}`, borderRadius: 999, padding: "12px 22px", display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 10, height: 10, borderRadius: 5, background: C.blue }} />
        <Mono size={18} color="#fff">
          {current.text}
        </Mono>
      </div>
    </Reveal>
  );
};

export const Room: React.FC = () => (
  <Shell id={id} eyebrow="03 · The control room">
    <Reveal at={2} y={40} scale={0.97}>
      <div style={{ position: "relative", boxShadow: "0 40px 100px rgba(0,0,0,0.65)", borderRadius: 18, border: `1px solid ${C.line}` }}>
        <Camera
          {...IMG}
          w={1740}
          h={780}
          keys={[
            { at: 0, x: 0, y: 0, width: 3200 },
            { at: T.seven, x: 740, y: 430, width: 1600 },
            { at: T.trouble, x: 740, y: 1300, width: 1600 },
            { at: T.move, x: 1290, y: 170, width: 1760 },
            { at: T.waiting, x: 2330, y: 1330, width: 880 },
            { at: T.agent, x: 2330, y: 850, width: 880 },
            { at: END - 60, x: 0, y: 0, width: 3200, dur: 50 },
          ]}
        />
        <Label />
      </div>
    </Reveal>
    <Sfx id="tick" at={T.seven} volume={0.4} />
    <Sfx id="tick" at={T.move} volume={0.4} />
    <Sfx id="tick" at={T.waiting} volume={0.4} />
    <Sfx id="chime" at={T.agent + 6} volume={0.3} />
  </Shell>
);
