import React from "react";
import { Img, interpolate, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Audio } from "@remotion/media";
import { C, F } from "./theme";
import { FPS, timings } from "./lib";
import type { SfxId } from "./script";

/** 0 -> 1 spring that starts at scene frame `at`. */
export function useEnter(at: number, damping = 200): number {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: Math.max(0, frame - at), fps, config: { damping }, durationInFrames: 26 });
}

export const Reveal: React.FC<{
  at: number;
  x?: number;
  y?: number;
  scale?: number;
  style?: React.CSSProperties;
  children: React.ReactNode;
}> = ({ at, x = 0, y = 28, scale = 1, style, children }) => {
  const p = useEnter(at);
  return (
    <div
      style={{
        opacity: p,
        transform: `translate(${(1 - p) * x}px, ${(1 - p) * y}px) scale(${scale + (1 - scale) * p})`,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

/** Typewriter: reveals `text` at `cps` characters per second starting at frame `at`. */
export const Typed: React.FC<{ text: string; at: number; cps?: number; cursor?: boolean }> = ({
  text,
  at,
  cps = 45,
  cursor = true,
}) => {
  const frame = useCurrentFrame();
  const n = Math.max(0, Math.min(text.length, Math.floor(((frame - at) / FPS) * cps)));
  const done = n >= text.length;
  return (
    <>
      {text.slice(0, n)}
      {cursor && frame >= at && !(done && Math.floor(frame / 15) % 2) ? (
        <span style={{ color: C.soft }}>▌</span>
      ) : null}
    </>
  );
};

export const Sfx: React.FC<{ id: SfxId; at: number; volume?: number }> = ({ id, at, volume = 0.55 }) => (
  <Sequence from={at} durationInFrames={Math.ceil(timings.sfx[id].duration * FPS) + 1} layout="none">
    <Audio src={staticFile(timings.sfx[id].file)} volume={volume} />
  </Sequence>
);

export const Mono: React.FC<{ children: React.ReactNode; size?: number; color?: string; style?: React.CSSProperties }> = ({
  children,
  size = 22,
  color = C.muted,
  style,
}) => (
  <div
    style={{
      fontFamily: F.mono,
      fontSize: size,
      letterSpacing: size * 0.14,
      textTransform: "uppercase",
      color,
      ...style,
    }}
  >
    {children}
  </div>
);

export const Mark: React.FC<{ size: number }> = ({ size }) => (
  <Img src={staticFile("brand/tessera-mark.png")} style={{ width: size, height: size, objectFit: "contain" }} />
);

/** Product-style (light) card used to echo the console UI. */
export const Card: React.FC<{ style?: React.CSSProperties; children: React.ReactNode }> = ({ style, children }) => (
  <div
    style={{
      background: C.paper,
      color: C.ink,
      border: `2px solid ${C.ink}`,
      boxShadow: "0 30px 80px rgba(0,0,0,0.5)",
      ...style,
    }}
  >
    {children}
  </div>
);

export const Pill: React.FC<{
  children: React.ReactNode;
  bg?: string;
  fg?: string;
  border?: string;
  size?: number;
}> = ({ children, bg = C.blue, fg = "#fff", border = "transparent", size = 24 }) => (
  <div
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 10,
      padding: `${size * 0.35}px ${size * 0.8}px`,
      background: bg,
      color: fg,
      border: `2px solid ${border}`,
      fontFamily: F.mono,
      fontWeight: 700,
      fontSize: size,
      letterSpacing: size * 0.12,
      textTransform: "uppercase",
      whiteSpace: "nowrap",
    }}
  >
    {children}
  </div>
);

/** Screenshot in a rounded window, panned vertically between `from` and `to` (0..1 of the overflow) across frames. */
export const PannedShot: React.FC<{
  src: string;
  imgW: number;
  imgH: number;
  w: number;
  h: number;
  start: number;
  end: number;
  from?: number;
  to?: number;
  style?: React.CSSProperties;
}> = ({ src, imgW, imgH, w, h, start, end, from = 0, to = 1, style }) => {
  const frame = useCurrentFrame();
  const scaledH = (w * imgH) / imgW;
  const overflow = Math.max(0, scaledH - h);
  const t = interpolate(frame, [start, end], [from, to], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const ease = t * t * (3 - 2 * t);
  return (
    <div style={{ width: w, height: h, overflow: "hidden", borderRadius: 14, background: "#fff", ...style }}>
      <Img src={staticFile(src)} style={{ width: w, display: "block", transform: `translateY(${-overflow * ease}px)` }} />
    </div>
  );
};

/** Where the camera looks on a screenshot, in the image's own pixels. It starts moving there at scene frame `at`. */
export type Focus = { at: number; x: number; y: number; width: number; dur?: number };

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * A large screenshot seen through a moving camera: from each keyframe's `at` it eases to that region over `dur` frames
 * (default 32), then holds, so a 2x capture of the console can show the whole board and lean in on one panel on the word
 * that names it, without ever upscaling past its pixels. A slow drift keeps a held shot alive.
 */
export const Camera: React.FC<{
  src: string;
  imgW: number;
  imgH: number;
  w: number;
  h: number;
  keys: Focus[];
  radius?: number;
  style?: React.CSSProperties;
}> = ({ src, imgW, imgH, w, h, keys, radius = 18, style }) => {
  const frame = useCurrentFrame();
  let x = keys[0]!.x;
  let y = keys[0]!.y;
  let width = keys[0]!.width;
  for (let i = 1; i < keys.length; i++) {
    const k = keys[i]!;
    const t = easeInOut(interpolate(frame, [k.at, k.at + (k.dur ?? 32)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
    x += (k.x - x) * t;
    y += (k.y - y) * t;
    width += (k.width - width) * t;
  }
  const drift = 1 + Math.min(frame, 900) * 0.00004;
  width /= drift;
  const scale = w / width;
  const viewH = h / scale;
  const cx = Math.max(0, Math.min(x, imgW - width));
  const cy = Math.max(0, Math.min(y, imgH - viewH));
  return (
    <div style={{ width: w, height: h, overflow: "hidden", borderRadius: radius, position: "relative", background: "#0b0c10", ...style }}>
      <Img
        src={staticFile(src)}
        style={{ position: "absolute", left: 0, top: 0, width: imgW * scale, height: imgH * scale, maxWidth: "none", transform: `translate(${-cx * scale}px, ${-cy * scale}px)` }}
      />
    </div>
  );
};
