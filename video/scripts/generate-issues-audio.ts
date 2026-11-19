// Voices the supplier-issues film with ElevenLabs: one narration file per beat (with word timestamps), a few sound effects,
// and a music bed as long as the film. Files that exist are kept; --force regenerates, --only=<beat> redoes one beat.
// Output: public/audio/issues/* and src/demo/timings.json.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { BEATS, MUSIC_PROMPT, SFX, TTS_MODEL, VOICE_ID } from "../src/issues/script";

const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) throw new Error("ELEVENLABS_API_KEY missing (video/.env)");
const FORCE = process.argv.includes("--force");
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
const API = "https://api.elevenlabs.io/v1";
const OUT = "public/audio/issues";
mkdirSync(OUT, { recursive: true });

async function call(path: string, body: unknown, query = ""): Promise<Response> {
  const res = await fetch(`${API}${path}${query}`, {
    method: "POST",
    headers: { "xi-api-key": KEY!, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res;
}

function duration(file: string): number {
  const r = Bun.spawnSync(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  return Number(r.stdout.toString().trim());
}

type Word = { text: string; start: number; end: number };
function toWords(chars: string[], starts: number[], ends: number[]): Word[] {
  const words: Word[] = [];
  let cur: Word | null = null;
  chars.forEach((c, i) => {
    if (/\s/.test(c)) {
      if (cur) words.push(cur);
      cur = null;
    } else if (cur) {
      cur.text += c;
      cur.end = ends[i]!;
    } else {
      cur = { text: c, start: starts[i]!, end: ends[i]! };
    }
  });
  if (cur) words.push(cur);
  return words;
}

const beats: Record<string, { file: string; duration: number; words: Word[] }> = {};
for (const [i, beat] of BEATS.entries()) {
  const file = `${OUT}/voice-${beat.id}.mp3`;
  const cache = `${OUT}/voice-${beat.id}.json`;
  if (FORCE || ONLY === beat.id || !existsSync(file) || !existsSync(cache)) {
    console.log(`voice  ${beat.id}`);
    const res = await call(
      `/text-to-speech/${VOICE_ID}/with-timestamps`,
      {
        text: beat.text,
        model_id: TTS_MODEL,
        // Neighbouring lines keep the prosody continuous across separately generated beats.
        previous_text: BEATS[i - 1]?.text,
        next_text: BEATS[i + 1]?.text,
        voice_settings: { stability: 0.42, similarity_boost: 0.82, style: 0.32, use_speaker_boost: true, speed: 0.97 },
      },
      "?output_format=mp3_44100_128",
    );
    const json = (await res.json()) as {
      audio_base64: string;
      alignment: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] };
    };
    await Bun.write(file, Buffer.from(json.audio_base64, "base64"));
    const a = json.alignment;
    await Bun.write(cache, JSON.stringify(toWords(a.characters, a.character_start_times_seconds, a.character_end_times_seconds)));
  }
  beats[beat.id] = { file: `audio/issues/voice-${beat.id}.mp3`, duration: duration(file), words: await Bun.file(cache).json() };
}

const sfx: Record<string, { file: string; duration: number }> = {};
for (const [id, prompt] of Object.entries(SFX)) {
  const file = `${OUT}/sfx-${id}.mp3`;
  if (FORCE || !existsSync(file)) {
    console.log(`sfx    ${id}`);
    const res = await call("/sound-generation", { text: prompt, duration_seconds: 1.5, prompt_influence: 0.5 }, "?output_format=mp3_44100_128");
    await Bun.write(file, await res.arrayBuffer());
  }
  sfx[id] = { file: `audio/issues/sfx-${id}.mp3`, duration: duration(file) };
}

// The bed runs the whole film: narration plus the breathing room the storyboard adds around each beat.
const narration = Object.values(beats).reduce((s, b) => s + b.duration, 0);
const musicFile = `${OUT}/music.mp3`;
if (FORCE || !existsSync(musicFile)) {
  const ms = Math.min(300_000, Math.ceil(narration + 60) * 1000);
  console.log(`music  ${ms / 1000}s`);
  const res = await call("/music", { prompt: MUSIC_PROMPT, music_length_ms: ms, force_instrumental: true }, "?output_format=mp3_44100_128");
  await Bun.write(musicFile, await res.arrayBuffer());
}

writeFileSync(
  "src/issues/timings.json",
  JSON.stringify({ beats, sfx, music: { file: "audio/issues/music.mp3", duration: duration(musicFile) } }, null, 1),
);
console.log(`done. narration ${narration.toFixed(1)}s`);
