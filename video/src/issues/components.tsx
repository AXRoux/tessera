import React, { useEffect, useRef } from "react";
import { AbsoluteFill, Img, interpolate, Sequence, staticFile, useCurrentFrame } from "remotion";
import { Audio } from "@remotion/media";
import { GLOBE_DOTS, unitVector } from "./globe-dots";
import { C, centre, clamp, ease, F, H, timings, W, type Rect, type Word } from "./kit";
import type { SfxId } from "./script";

/* ── The desk: the console's dotted grid, lit softly from two corners ─────────────────────────────────────────── */

export const Desk: React.FC<{ children?: React.ReactNode; glow?: string }> = ({ children, glow = "rgba(43,116,255,0.16)" }) => (
  <AbsoluteFill style={{ background: C.canvas }}>
    <AbsoluteFill style={{ backgroundImage: `radial-gradient(${C.dot} 2.6px, transparent 3px)`, backgroundSize: "44px 44px", backgroundPosition: "-22px -22px" }} />
    <AbsoluteFill style={{ background: `radial-gradient(60% 55% at 30% -10%, ${glow} 0%, transparent 60%), radial-gradient(50% 60% at 105% 110%, rgba(43,116,255,0.10) 0%, transparent 60%)` }} />
    <AbsoluteFill style={{ background: "radial-gradient(120% 90% at 50% 50%, transparent 55%, rgba(0,0,0,0.55) 100%)" }} />
    {children}
  </AbsoluteFill>
);

/* ── A sound at a frame ────────────────────────────────────────────────────────────────────────────────────────── */

export const Sfx: React.FC<{ id: SfxId; at: number; volume?: number }> = ({ id, at, volume = 0.5 }) => (
  <Sequence from={Math.max(0, at)} durationInFrames={Math.ceil(timings.sfx[id].duration * 30) + 2} layout="none">
    <Audio src={staticFile(timings.sfx[id].file)} volume={volume} />
  </Sequence>
);

/* ── The screen: a 4K capture of the console in a window, with a camera that eases between areas of it ───────── */

export type Layer = { from: number; file: string; fade?: number };
export type Cam = { at: number; focus?: Rect | null; zoom?: number; dur?: number };
export type Ring = { from: number; to: number; rect: Rect; tone?: string; label?: string };
export type CursorTrack = { points: { at: number; x: number; y: number }[]; clicks?: number[]; typeAt?: { from: number; to: number } };

const FRAME_SCALE = 0.94;

function camera(focus: Rect | null | undefined, zoom: number | undefined) {
  if (!focus) return { s: 1, tx: 0, ty: 0 };
  const fit = Math.min((W * 0.84) / focus.w, (H * 0.84) / focus.h);
  const s = Math.max(1, Math.min(zoom ?? fit, zoom ?? 2.4));
  const c = centre(focus);
  const tx = Math.min(0, Math.max(W - W * s, W / 2 - c.x * s));
  const ty = Math.min(0, Math.max(H - H * s, H / 2 - c.y * s));
  return { s, tx, ty };
}

function camAt(frame: number, cams: Cam[]) {
  let prev = camera(null, 1);
  let cur = prev;
  let t = 1;
  for (const k of cams) {
    if (frame < k.at) break;
    prev = cur;
    cur = camera(k.focus, k.zoom);
    t = ease(interpolate(frame, [k.at, k.at + (k.dur ?? 34)], [0, 1], clamp));
  }
  return { s: prev.s + (cur.s - prev.s) * t, tx: prev.tx + (cur.tx - prev.tx) * t, ty: prev.ty + (cur.ty - prev.ty) * t };
}

/** A macOS-style pointer that eases between points and ripples when it clicks; drawn at a constant size on screen. */
const Pointer: React.FC<{ track: CursorTrack; s: number }> = ({ track, s }) => {
  const frame = useCurrentFrame();
  const pts = track.points;
  if (pts.length === 0 || frame < pts[0]!.at - 10) return null;
  let x = pts[0]!.x;
  let y = pts[0]!.y;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const t = ease(interpolate(frame, [a.at, b.at], [0, 1], clamp));
    if (frame >= a.at) {
      x = a.x + (b.x - a.x) * t;
      y = a.y + (b.y - a.y) * t;
    }
  }
  const press = (track.clicks ?? []).some((c) => frame >= c && frame < c + 6);
  const appear = interpolate(frame, [pts[0]!.at - 10, pts[0]!.at], [0, 1], clamp);
  const k = 1 / s;
  return (
    <>
      {(track.clicks ?? []).map((c) => {
        const p = interpolate(frame, [c, c + 22], [0, 1], clamp);
        if (frame < c || p >= 1) return null;
        return (
          <div
            key={c}
            style={{
              position: "absolute", left: x, top: y, width: 120 * k, height: 120 * k, marginLeft: -60 * k, marginTop: -60 * k, borderRadius: "50%",
              border: `${5 * k}px solid ${C.accent}`, opacity: 1 - p, transform: `scale(${0.3 + p * 1.1})`,
            }}
          />
        );
      })}
      <svg
        viewBox="0 0 24 24"
        style={{ position: "absolute", left: x, top: y, width: 64 * k, height: 64 * k, marginLeft: -12 * k, marginTop: -6 * k, opacity: appear, transform: `scale(${press ? 0.86 : 1})`, transformOrigin: "20% 15%", filter: "drop-shadow(0 6px 10px rgba(0,0,0,0.55))" }}
      >
        <path d="M5.5 3.2v15.6l4.1-3.9 2.6 6.1 2.9-1.2-2.6-6h5.8z" fill="#fff" stroke="#0a0b0d" strokeWidth="1.3" strokeLinejoin="round" />
      </svg>
    </>
  );
};

/** The console, captured, in a window on the desk; layers cross-fade, the camera moves, rings and a cursor ride along. */
export const Screen: React.FC<{ layers: Layer[]; cams?: Cam[]; rings?: Ring[]; cursor?: CursorTrack; children?: React.ReactNode }> = ({ layers, cams = [], rings = [], cursor, children }) => {
  const frame = useCurrentFrame();
  const { s, tx, ty } = camAt(frame, cams);
  const drift = 1 + interpolate(frame, [0, 900], [0, 0.012], clamp);
  return (
    <Desk>
      <div
        style={{
          position: "absolute", left: (W * (1 - FRAME_SCALE)) / 2, top: (H * (1 - FRAME_SCALE)) / 2, width: W * FRAME_SCALE, height: H * FRAME_SCALE,
          borderRadius: 54, overflow: "hidden", boxShadow: "0 90px 180px -40px rgba(0,0,0,0.85), 0 0 0 2px rgba(255,255,255,0.07)", background: C.canvas,
        }}
      >
        <div style={{ position: "absolute", left: 0, top: 0, width: W, height: H, transformOrigin: "0 0", transform: `scale(${FRAME_SCALE}) translate(${tx}px, ${ty}px) scale(${s * drift})` }}>
          {layers.map((l, i) => {
            const next = layers[i + 1];
            if (frame < l.from - (l.fade ?? 10) || (next && frame >= next.from + (next.fade ?? 10))) return null;
            const op = i === 0 ? 1 : interpolate(frame, [l.from - (l.fade ?? 10), l.from], [0, 1], clamp);
            return <Img key={`${l.file}-${i}`} src={staticFile(l.file)} style={{ position: "absolute", inset: 0, width: W, height: H, opacity: op }} />;
          })}
          {rings.map((r, i) => {
            if (frame < r.from || frame > r.to + 12) return null;
            const inT = ease(interpolate(frame, [r.from, r.from + 14], [0, 1], clamp));
            const outT = interpolate(frame, [r.to, r.to + 12], [1, 0], clamp);
            const tone = r.tone ?? C.accent;
            return (
              <div
                key={i}
                style={{
                  position: "absolute", left: r.rect.x - 14, top: r.rect.y - 14, width: r.rect.w + 28, height: r.rect.h + 28, borderRadius: 30,
                  border: `${6 / s}px solid ${tone}`, boxShadow: `0 0 ${60 / s}px ${tone}66, inset 0 0 ${40 / s}px ${tone}22`,
                  opacity: inT * outT, transform: `scale(${1.04 - 0.04 * inT})`, transformOrigin: "center",
                }}
              />
            );
          })}
          {cursor ? <Pointer track={cursor} s={s * drift} /> : null}
        </div>
      </div>
      {children}
    </Desk>
  );
};

/** A time-lapse: a burst of frames spread over [from, to], each cross-fading into the next. */
export const burstLayers = (files: string[], from: number, to: number): Layer[] => {
  if (files.length === 0) return [];
  const step = (to - from) / files.length;
  return files.map((file, i) => ({ from: Math.round(from + i * step), file, fade: Math.min(8, Math.round(step / 2)) }));
};

/* ── Captions: the spoken phrase, the current word lit ─────────────────────────────────────────────────────────── */

function phrases(words: Word[]): Word[][] {
  const out: Word[][] = [];
  let cur: Word[] = [];
  for (const w of words) {
    cur.push(w);
    if (/[,;:.?!—]$/.test(w.text) || cur.length >= 9) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

export const Captions: React.FC<{ words: Word[]; lead: number }> = ({ words, lead }) => {
  const frame = useCurrentFrame();
  const t = (frame - lead) / 30;
  const groups = phrases(words);
  const g = groups.find((p) => t >= p[0]!.start - 0.05 && t <= p.at(-1)!.end + 0.35);
  if (!g) return null;
  const inT = interpolate(t, [g[0]!.start - 0.05, g[0]!.start + 0.12], [0, 1], clamp);
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 96, display: "flex", justifyContent: "center", pointerEvents: "none" }}>
      <div
        style={{
          maxWidth: 2700, padding: "26px 54px", borderRadius: 999, background: "rgba(10,11,13,0.74)", backdropFilter: "blur(30px)",
          border: "2px solid rgba(255,255,255,0.08)", boxShadow: "0 30px 80px -30px rgba(0,0,0,0.8)",
          fontFamily: F.ui, fontSize: 58, fontWeight: 500, letterSpacing: -0.6, lineHeight: 1.25, color: C.faint, opacity: inT, textAlign: "center",
        }}
      >
        {g.map((w, i) => (
          <span key={i} style={{ color: t >= w.start - 0.02 ? C.fg : C.faint, transition: "none" }}>
            {w.text.replace(/[“”]/g, (q) => q)}
            {i < g.length - 1 ? " " : ""}
          </span>
        ))}
      </div>
    </div>
  );
};

/* ── Chapter tag: the supplier, its problem in red, and where it landed in green ───────────────────────────────── */

export type Supplier = { id: string; name: string; bg: string; fg: string };
export const SUPPLIERS: Record<string, Supplier> = {
  modal: { id: "modal", name: "Modal", bg: "#0b0f0a", fg: "#7fee64" },
  primeintellect: { id: "primeintellect", name: "Prime Intellect", bg: "#050505", fg: "#ffffff" },
  replicate: { id: "replicate", name: "Replicate", bg: "#ffffff", fg: "#000000" },
  langchain: { id: "langchain", name: "LangChain", bg: "#030710", fg: "#7fc8ff" },
  fal: { id: "fal", name: "fal", bg: "#f2efff", fg: "#140d33" },
  framer: { id: "framer", name: "Framer", bg: "#0055ff", fg: "#ffffff" },
};
const SCALE: Record<string, number> = { framer: 0.5, langchain: 0.52, modal: 0.6, primeintellect: 0.66, replicate: 0.52, fal: 0.5 };

export const Mark: React.FC<{ s: Supplier; size: number; round?: boolean }> = ({ s, size, round = false }) => {
  const inner = Math.round(size * (SCALE[s.id] ?? 0.55));
  const src = staticFile(`suppliers/${s.id}.svg`);
  return (
    <div style={{ width: size, height: size, borderRadius: round ? "50%" : size * 0.28, background: s.bg, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: s.bg.startsWith("#f") ? "inset 0 0 0 2px rgba(0,0,0,0.1)" : undefined, flexShrink: 0 }}>
      <div style={{ width: inner, height: inner, background: s.fg, mask: `url(${src}) center / contain no-repeat`, WebkitMask: `url(${src}) center / contain no-repeat` }} />
    </div>
  );
};

export const Chapter: React.FC<{ n: string; supplier: Supplier; problem: string; outcome?: string; outcomeAt?: number; outcomeTone?: string }> = ({ n, supplier, problem, outcome, outcomeAt = 99999, outcomeTone = C.ok }) => {
  const frame = useCurrentFrame();
  const inT = ease(interpolate(frame, [4, 26], [0, 1], clamp));
  const outT = ease(interpolate(frame, [outcomeAt, outcomeAt + 18], [0, 1], clamp));
  return (
    <div
      style={{
        position: "absolute", left: 200, top: 168, display: "flex", alignItems: "center", gap: 28, padding: "22px 40px 22px 22px", borderRadius: 999,
        background: "rgba(14,15,18,0.86)", backdropFilter: "blur(30px)", border: "2px solid rgba(255,255,255,0.08)", boxShadow: "0 40px 100px -30px rgba(0,0,0,0.9)",
        opacity: inT, transform: `translateY(${(1 - inT) * -30}px)`,
      }}
    >
      <Mark s={supplier} size={92} round />
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ fontFamily: F.mono, fontSize: 30, letterSpacing: 3, color: C.muted, textTransform: "uppercase" }}>
          {n} · {supplier.name}
        </div>
        <div style={{ fontFamily: F.ui, fontSize: 50, fontWeight: 600, letterSpacing: -1, display: "flex", alignItems: "center", gap: 22 }}>
          <span style={{ color: outT > 0.5 ? "rgba(243,244,246,0.4)" : C.bad, textDecoration: outT > 0.5 ? "line-through" : undefined, textDecorationColor: "rgba(243,244,246,0.25)" }}>{problem}</span>
          {outcome && outT > 0 ? (
            <span style={{ color: outcomeTone, opacity: outT, transform: `translateX(${(1 - outT) * 20}px)`, display: "flex", alignItems: "center", gap: 18 }}>
              <span style={{ color: C.faint }}>→</span>
              {outcome}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
};

/* ── The globe, drawn natively: the same land dots and supplier headquarters as the console's case map ────────── */

export type GlobePin = { s: Supplier; lat: number; lon: number; metro: string; tone: string; pulse?: boolean; show?: number };
const DEG = Math.PI / 180;

export const NativeGlobe: React.FC<{ pins: GlobePin[]; lon: number; lat: number; radius: number; cx?: number; cy?: number; ink?: string; dim?: number }> = ({ pins, lon, lat, radius, cx = W / 2, cy = H / 2, ink = "243,244,246", dim = 1 }) => {
  const frame = useCurrentFrame();
  const ref = useRef<HTMLCanvasElement>(null);
  const p = lat * DEG;
  const l = lon * DEG;
  const e = [-Math.sin(l), Math.cos(l), 0];
  const n = [-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p)];
  const v = [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    const rgba = (a: number) => `rgba(${ink},${a * dim})`;
    const halo = ctx.createRadialGradient(cx, cy, radius * 0.96, cx, cy, radius * 1.16);
    halo.addColorStop(0, rgba(0.1));
    halo.addColorStop(1, rgba(0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 1.16, 0, Math.PI * 2);
    ctx.fill();
    const body = ctx.createRadialGradient(cx - radius * 0.35, cy - radius * 0.4, radius * 0.05, cx, cy, radius);
    body.addColorStop(0, rgba(0.09));
    body.addColorStop(1, rgba(0.012));
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = rgba(0.16);
    ctx.lineWidth = 3;
    ctx.stroke();
    const paths = Array.from({ length: 6 }, () => new Path2D());
    const scale = radius / 240;
    for (let i = 0; i < GLOBE_DOTS.length; i += 3) {
      const px = GLOBE_DOTS[i]!, py = GLOBE_DOTS[i + 1]!, pz = GLOBE_DOTS[i + 2]!;
      const z = px * v[0]! + py * v[1]! + pz * v[2]!;
      if (z <= 0.03) continue;
      const x = px * e[0]! + py * e[1]!;
      const y = px * n[0]! + py * n[1]! + pz * n[2]!;
      const b = Math.min(5, Math.floor(z * 6));
      const r = (0.55 + 0.17 * b) * scale * 0.82 + 0.4;
      const sx = cx + x * radius, sy = cy - y * radius;
      paths[b]!.moveTo(sx + r, sy);
      paths[b]!.arc(sx, sy, r, 0, Math.PI * 2);
    }
    paths.forEach((path, b) => {
      ctx.fillStyle = rgba(0.13 + 0.135 * b);
      ctx.fill(path);
    });
  }, [frame, lon, lat, radius, cx, cy, ink, dim]);

  const project = (la: number, lo: number) => {
    const [qx, qy, qz] = unitVector(la, lo);
    return { x: cx + (qx * e[0]! + qy * e[1]!) * radius, y: cy - (qx * n[0]! + qy * n[1]! + qz * n[2]!) * radius, z: qx * v[0]! + qy * v[1]! + qz * v[2]! };
  };
  const metros = new Map<string, { x: number; y: number; n: number; ids: string[] }>();
  for (const pin of pins) {
    const a = project(pin.lat, pin.lon);
    const m = metros.get(pin.metro) ?? { x: 0, y: 0, n: 0, ids: [] };
    metros.set(pin.metro, { x: m.x + a.x, y: m.y + a.y, n: m.n + 1, ids: [...m.ids, pin.s.id] });
  }
  const size = Math.round(radius * 0.16);
  return (
    <AbsoluteFill>
      <canvas ref={ref} width={W} height={H} style={{ position: "absolute", inset: 0 }} />
      {pins.map((pin) => {
        const a = project(pin.lat, pin.lon);
        const m = metros.get(pin.metro)!;
        const idx = m.ids.indexOf(pin.s.id);
        const ang = -Math.PI / 2 + (idx * 2 * Math.PI) / m.ids.length;
        const off = m.ids.length > 1 ? size * 0.66 : 0;
        const x = m.x / m.n + Math.cos(ang) * off;
        const y = m.y / m.n + Math.sin(ang) * off;
        const shown = interpolate(frame, [pin.show ?? 0, (pin.show ?? 0) + 14], [0, 1], clamp) * (a.z > 0.1 ? Math.min(1, (a.z - 0.1) * 6) : 0);
        const pulse = pin.pulse ? (Math.sin(frame / 7) + 1) / 2 : 0;
        return (
          <div key={pin.s.id} style={{ position: "absolute", left: x, top: y, transform: `translate(-50%, -50%) scale(${0.6 + 0.4 * shown})`, opacity: shown }}>
            {pin.pulse ? <div style={{ position: "absolute", inset: -size * 0.28, borderRadius: "50%", background: pin.tone, opacity: 0.18 + 0.22 * pulse, transform: `scale(${1 + 0.25 * pulse})` }} /> : null}
            <div style={{ position: "relative", borderRadius: "50%", boxShadow: `0 0 0 ${size * 0.07}px ${pin.tone}, 0 ${size * 0.25}px ${size * 0.6}px -${size * 0.2}px rgba(0,0,0,0.8)` }}>
              <Mark s={pin.s} size={size} round />
            </div>
            <div style={{ position: "absolute", right: -size * 0.06, bottom: -size * 0.06, width: size * 0.3, height: size * 0.3, borderRadius: "50%", background: pin.tone, boxShadow: `0 0 0 ${size * 0.06}px ${C.canvas}` }} />
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

/** Where each supplier on the globe is headquartered (web/lib/supplier-places.ts). */
export const PLACES: Record<string, { lat: number; lon: number; metro: string }> = {
  modal: { lat: 40.7257, lon: -74.0048, metro: "new-york" },
  replicate: { lat: 37.7803, lon: -122.3906, metro: "bay-area" },
  fal: { lat: 37.7793, lon: -122.4193, metro: "bay-area" },
  langchain: { lat: 37.7793, lon: -122.4193, metro: "bay-area" },
  primeintellect: { lat: 37.7793, lon: -122.4193, metro: "bay-area" },
  framer: { lat: 52.3724, lon: 4.8775, metro: "amsterdam" },
};

/* ── Type on the desk ──────────────────────────────────────────────────────────────────────────────────────────── */

export const Kicker: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
  <div style={{ fontFamily: F.mono, fontSize: 40, letterSpacing: 6, textTransform: "uppercase", color: C.muted, ...style }}>{children}</div>
);

/** A line that rises into place at `at`. */
export const Rise: React.FC<{ at: number; children: React.ReactNode; style?: React.CSSProperties; dur?: number }> = ({ at, children, style, dur = 22 }) => {
  const frame = useCurrentFrame();
  const t = ease(interpolate(frame, [at, at + dur], [0, 1], clamp));
  return <div style={{ opacity: t, transform: `translateY(${(1 - t) * 50}px)`, filter: `blur(${(1 - t) * 14}px)`, ...style }}>{children}</div>;
};
