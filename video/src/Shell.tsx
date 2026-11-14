import React, { useMemo } from "react";
import { AbsoluteFill, interpolate, Sequence, staticFile, useCurrentFrame } from "remotion";
import { Audio } from "@remotion/media";
import { C, F } from "./theme";
import { FPS, LEAD, sceneFrames, timings, type Word } from "./lib";
import type { SceneId } from "./script";
import { Mark, Mono, Sfx } from "./ui";

function chunk(words: Word[]): Word[][] {
  const out: Word[][] = [];
  let cur: Word[] = [];
  for (const w of words) {
    cur.push(w);
    const end = /[.?!:]$/.test(w.text);
    const comma = /[,;]$/.test(w.text);
    if ((end && cur.length >= 3) || (comma && cur.length >= 6) || cur.length >= 9) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

const Captions: React.FC<{ id: SceneId }> = ({ id }) => {
  const frame = useCurrentFrame();
  const chunks = useMemo(() => chunk(timings.scenes[id].words), [id]);
  const t = (frame - LEAD) / FPS;
  if (t < 0) return null;
  let current = chunks[0]!;
  for (const c of chunks) if (c[0]!.start <= t) current = c;
  const last = current[current.length - 1]!;
  if (t > last.end + 0.6 && current === chunks[chunks.length - 1]) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: 170,
        right: 170,
        bottom: 62,
        height: 120,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        fontFamily: F.body,
        fontWeight: 600,
        fontSize: 44,
        lineHeight: 1.25,
        textShadow: "0 2px 18px rgba(0,0,0,0.9)",
      }}
    >
      <div>
        {current.map((w, i) => {
          const spoken = w.start <= t;
          const active = spoken && t < w.end + 0.04;
          return (
            <span key={i} style={{ color: active ? C.soft : spoken ? "#fff" : "rgba(255,255,255,0.32)" }}>
              {w.text}{" "}
            </span>
          );
        })}
      </div>
    </div>
  );
};

/** Scene chrome: grid background, eyebrow, brand mark, captions, voice-over and the transition whoosh. */
export const Shell: React.FC<{ id: SceneId; eyebrow: string; children: React.ReactNode }> = ({ id, eyebrow, children }) => {
  const frame = useCurrentFrame();
  const total = sceneFrames(id);
  const fade = interpolate(frame, [0, 9, total - 10, total], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill style={{ background: C.ink, fontFamily: F.body, color: "#fff" }}>
      <AbsoluteFill
        style={{
          opacity: fade,
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)",
          backgroundSize: "60px 60px",
        }}
      />
      <AbsoluteFill style={{ opacity: fade }}>
        <div style={{ position: "absolute", left: 90, top: 46, display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ width: 16, height: 16, background: C.blue }} />
          <Mono size={20} color={C.soft}>
            {eyebrow}
          </Mono>
        </div>
        <div style={{ position: "absolute", right: 90, top: 36, display: "flex", alignItems: "center", gap: 14 }}>
          <Mark size={40} />
          <div style={{ fontFamily: F.display, fontSize: 24, letterSpacing: 3 }}>TESSERA</div>
        </div>
        <div style={{ position: "absolute", left: 90, top: 110, width: 1740, height: 780 }}>{children}</div>
        <Captions id={id} />
      </AbsoluteFill>
      <Sequence from={LEAD} layout="none">
        <Audio src={staticFile(timings.scenes[id].file)} volume={1} />
      </Sequence>
      <Sfx id="whoosh" at={0} volume={0.3} />
    </AbsoluteFill>
  );
};
