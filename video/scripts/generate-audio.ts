// Generates every sound in the video with ElevenLabs:
//   - narration     /v1/text-to-speech/:voice/with-timestamps   (audio + per-character alignment)
//   - sound effects /v1/sound-generation
//   - music bed     /v1/music
// Files that already exist are kept; pass --force to regenerate. Output: public/audio/*.mp3 and src/timings.json.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { MUSIC_PROMPT, SCENES, SFX, TTS_MODEL, VOICE_ID } from "../src/script";

const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) throw new Error("ELEVENLABS_API_KEY missing (video/.env)");
const FORCE = process.argv.includes("--force");
const API = "https://api.elevenlabs.io/v1";
const OUT = "public/audio";
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

const timings: Record<string, { file: string; duration: number; words: Word[] }> = {};

// Narration. previous_text / next_text keep prosody continuous across separately generated scenes.
for (const [i, scene] of SCENES.entries()) {
  const file = `${OUT}/voice-${scene.id}.mp3`;
  const cache = `${OUT}/voice-${scene.id}.json`;
  if (FORCE || !existsSync(file) || !existsSync(cache)) {
    console.log(`voice  ${scene.id}`);
    const res = await call(
      `/text-to-speech/${VOICE_ID}/with-timestamps`,
      {
        text: scene.text,
        model_id: TTS_MODEL,
        previous_text: SCENES[i - 1]?.text,
        next_text: SCENES[i + 1]?.text,
        voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.25, use_speaker_boost: true, speed: 1.04 },
      },
      "?output_format=mp3_44100_128",
    );
    const json = (await res.json()) as {
      audio_base64: string;
      alignment: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] };
    };
    await Bun.write(file, Buffer.from(json.audio_base64, "base64"));
    const a = json.alignment;
    await Bun.write(
      cache,
      JSON.stringify(toWords(a.characters, a.character_start_times_seconds, a.character_end_times_seconds)),
    );
  }
  timings[scene.id] = {
    file: `audio/voice-${scene.id}.mp3`,
    duration: duration(file),
    words: await Bun.file(cache).json(),
  };
}

// Sound effects.
const sfx: Record<string, { file: string; duration: number }> = {};
for (const [id, prompt] of Object.entries(SFX)) {
  const file = `${OUT}/sfx-${id}.mp3`;
  if (FORCE || !existsSync(file)) {
    console.log(`sfx    ${id}`);
    const res = await call("/sound-generation", { text: prompt, duration_seconds: id === "impact" ? 2.5 : 1.5, prompt_influence: 0.5 }, "?output_format=mp3_44100_128");
    await Bun.write(file, await res.arrayBuffer());
  }
  sfx[id] = { file: `audio/sfx-${id}.mp3`, duration: duration(file) };
}

// Music bed: long enough for the whole cut, trimmed by the composition.
const musicFile = `${OUT}/music.mp3`;
if (FORCE || !existsSync(musicFile)) {
  console.log("music");
  const res = await call("/music", { prompt: MUSIC_PROMPT, music_length_ms: 270_000, force_instrumental: true }, "?output_format=mp3_44100_128");
  await Bun.write(musicFile, await res.arrayBuffer());
}

writeFileSync(
  "src/timings.json",
  JSON.stringify({ scenes: timings, sfx, music: { file: "audio/music.mp3", duration: duration(musicFile) } }, null, 1),
);
const total = Object.values(timings).reduce((s, t) => s + t.duration, 0);
console.log(`done. narration total ${total.toFixed(1)}s`);
