import timingsJson from "./timings.json";
import { SCENES, type SceneId, type SfxId } from "./script";

export const FPS = 30;
export const W = 1920;
export const H = 1080;
export const LEAD = Math.round(0.4 * FPS); // silence before each voice-over
export const TAIL = Math.round(0.55 * FPS); // breathing room after it

export type Word = { text: string; start: number; end: number };
type SceneTiming = { file: string; duration: number; words: Word[] };
export const timings = timingsJson as unknown as {
  scenes: Record<SceneId, SceneTiming>;
  sfx: Record<SfxId, { file: string; duration: number }>;
  music: { file: string; duration: number };
};

export const sceneFrames = (id: SceneId) => LEAD + Math.ceil(timings.scenes[id].duration * FPS) + TAIL;

export const sceneStart = (id: SceneId) => {
  let at = 0;
  for (const s of SCENES) {
    if (s.id === id) return at;
    at += sceneFrames(s.id);
  }
  throw new Error(`unknown scene ${id}`);
};

export const TOTAL = SCENES.reduce((n, s) => n + sceneFrames(s.id), 0);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Frame (relative to the scene start) at which the voice begins saying `phrase`. Throws when the phrase is not spoken. */
export function cue(id: SceneId, phrase: string, nth = 0): number {
  const words = timings.scenes[id].words;
  const target = phrase.split(/\s+/).map(norm);
  let seen = 0;
  for (let i = 0; i + target.length <= words.length; i++) {
    if (target.every((t, j) => norm(words[i + j]!.text) === t)) {
      if (seen++ === nth) return LEAD + Math.round(words[i]!.start * FPS);
    }
  }
  throw new Error(`cue "${phrase}" not found in scene ${id}`);
}
