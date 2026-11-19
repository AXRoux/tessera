import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadPlex } from "@remotion/google-fonts/IBMPlexMono";
import { Easing } from "remotion";
import shotsJson from "./shots.json";
import timingsJson from "./timings.json";
import { BEATS, type BeatId, type SfxId } from "./script";

// The control room's own type and colour (web/app/globals.css, dark palette).
export const F = {
  ui: loadInter("normal", { weights: ["400", "500", "600", "700"], subsets: ["latin"] }).fontFamily,
  mono: loadPlex("normal", { weights: ["400", "500"], subsets: ["latin"] }).fontFamily,
};
export const C = {
  canvas: "#0a0b0d",
  dot: "#1b1e24",
  fg: "#f3f4f6",
  muted: "rgba(243,244,246,0.55)",
  faint: "rgba(243,244,246,0.32)",
  tile: "#17181c",
  tileBottom: "#08090a",
  line: "rgba(255,255,255,0.08)",
  accent: "#2b74ff",
  warn: "#ffa629",
  bad: "#ff4f5e",
  ok: "#33d68a",
};

export const FPS = 30;
export const W = 3840;
export const H = 2160;
/** The film is drawn at 4K; every size below is in 4K pixels. The console was captured at 1920 CSS pixels, at 2x. */
export const DPR = 2;

export type Word = { text: string; start: number; end: number };
export const timings = timingsJson as unknown as {
  beats: Record<BeatId, { file: string; duration: number; words: Word[] }>;
  sfx: Record<SfxId, { file: string; duration: number }>;
  music: { file: string; duration: number };
};

/** Silence before a beat's voice, and room after it: longer at the open and the close, so the film can breathe. */
const LEAD: Partial<Record<BeatId, number>> = { open: 2.2, stakes: 0.8, room: 0.9, close: 1.0 };
const TAIL: Partial<Record<BeatId, number>> = { open: 1.2, stakes: 1.0, layer: 1.2, loaded: 0.9, agent: 1.6, settle: 1.4, close: 4.2 };
export const leadOf = (id: BeatId) => Math.round((LEAD[id] ?? 0.55) * FPS);
export const beatFrames = (id: BeatId) => leadOf(id) + Math.ceil(timings.beats[id].duration * FPS) + Math.round((TAIL[id] ?? 0.85) * FPS);
export const beatStart = (id: BeatId) => {
  let at = 0;
  for (const b of BEATS) {
    if (b.id === id) return at;
    at += beatFrames(b.id);
  }
  throw new Error(`no beat ${id}`);
};
export const TOTAL = BEATS.reduce((n, b) => n + beatFrames(b.id), 0);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/** The frame (from the beat's start) at which the voice begins `phrase`. Throws if it is never said, so a cue cannot drift. */
export function cue(id: BeatId, phrase: string, nth = 0): number {
  const words = timings.beats[id].words;
  const target = phrase.split(/\s+/).map(norm).filter(Boolean);
  let seen = 0;
  for (let i = 0; i + target.length <= words.length; i++) {
    if (target.every((t, j) => norm(words[i + j]!.text) === t) && seen++ === nth) return leadOf(id) + Math.round(words[i]!.start * FPS);
  }
  throw new Error(`cue "${phrase}" not said in ${id}`);
}
/** When the beat's voice ends, from the beat's start. */
export const voiceEnd = (id: BeatId) => leadOf(id) + Math.ceil(timings.beats[id].duration * FPS);

export type Rect = { x: number; y: number; w: number; h: number };
type Shot = { file: string; rects: Record<string, Rect> };
const shots = shotsJson as unknown as { shots: Record<string, Shot>; bursts: Record<string, string[]> };
export const shotFile = (name: string) => {
  const s = shots.shots[name];
  if (!s) throw new Error(`no shot ${name}`);
  return s.file;
};
/** A named rect in a shot, in 4K image pixels. */
export function rect(name: string, target: string, pad = 0): Rect {
  const r = shots.shots[name]?.rects[target];
  if (!r) throw new Error(`no rect ${target} in ${name}`);
  return { x: (r.x - pad) * DPR, y: (r.y - pad) * DPR, w: (r.w + pad * 2) * DPR, h: (r.h + pad * 2) * DPR };
}
export const hasRect = (name: string, target: string) => Boolean(shots.shots[name]?.rects[target]);
export const burstFiles = (name: string) => shots.bursts[name] ?? [];
/** A rect from CSS pixels of the 1920x1080 capture. */
export const css = (x: number, y: number, w: number, h: number): Rect => ({ x: x * DPR, y: y * DPR, w: w * DPR, h: h * DPR });
export const centre = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

export const ease = Easing.bezier(0.45, 0, 0.15, 1);
export const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
