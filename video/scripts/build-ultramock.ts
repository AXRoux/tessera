// Builds the Demo Day film's pictures in Ultramock, cut to the recorded narration.
//
// Each beat of src/demo/script.ts becomes a run of Ultramock shots. A shot starts on the word the narrator reaches it
// (`cue`), so the screen changes when the voice does. Ultramock caps a project at 180 s (seams included), so the film is three projects
// (PARTS), exported separately and laid end to end by the Remotion composition (src/demo/DemoDay.tsx), which also
// places each beat's voice from src/demo/cut.json, written here.
//
//   bun run scripts/build-ultramock.ts            check only (Ultramock dry run)
//   bun run scripts/build-ultramock.ts --apply    create (or rebuild) both projects
//
// Needs ULTRAMOCK_KEY in video/.env, and scripts/ultramock-images.json (the uploaded screens).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { BEATS, type BeatId } from "../src/demo/script";
import timingsJson from "../src/demo/timings.json";

const KEY = process.env.ULTRAMOCK_KEY;
if (!KEY) throw new Error("ULTRAMOCK_KEY missing (video/.env)");
const APPLY = process.argv.includes("--apply");

/** Silence before each beat's voice, and the breath after it. */
export const LEAD = 0.6;
export const TAIL = 1.8;
/** The closing logo holds this long after the last word. */
const END_HOLD = 3.5;

type Words = { text: string; start: number; end: number }[];
const timings = timingsJson as unknown as { beats: Record<BeatId, { duration: number; words: Words }> };
const images: Record<string, string> = JSON.parse(readFileSync("scripts/ultramock-images.json", "utf8"));

type Box = [number, number, number, number];
type Shot =
  | { cue?: string; card: string; size?: number; effect?: string; per?: "line" | "word" | "character" }
  | { cue?: string; logo: true }
  | { cue?: string; crop: string; move?: string }
  | {
      cue?: string;
      screen: string;
      framing: string;
      focus?: Box;
      move?: string;
      enter?: string;
      exit?: string;
      caption?: string;
      accents?: string[];
    };

// Regions of the 2880x1800 captures, as fractions of the image.
const R = {
  header: [0.605, 0.08, 0.98, 0.415] as Box,
  sealedRows: [0.375, 0.62, 0.69, 0.895] as Box,
  window: [0.035, 0.39, 0.335, 0.66] as Box,
  heldBack: [0.035, 0.52, 0.335, 0.79] as Box,
  supplier: [0.375, 0.3, 0.7, 0.61] as Box,
  simulate: [0.72, 0.6, 0.9675, 0.82] as Box,
  cancelledRows: [0.375, 0.395, 0.69, 0.67] as Box,
  replaceReasons: [0.02, 0.25, 0.35, 0.55] as Box,
  replaceButton: [0.72, 0.67, 0.9675, 0.89] as Box,
  attempts: [0.34, 0.3, 0.73, 0.65] as Box,
  refused: [0.375, 0.45, 0.69, 0.725] as Box,
  notFinal: [0.02, 0.33, 0.35, 0.63] as Box,
  certificate: [0.32, 0.33, 0.75, 0.715] as Box,
  sealedNote: [0.375, 0.3, 0.7, 0.61] as Box,
  chart: [0.24, 0.25, 0.72, 0.7] as Box,
  duplicate: [0.025, 0.6, 0.27, 0.82] as Box,
};

const LAPTOP = "macbook-pro-16";

// The storyboard: one idea per shot, on the word that introduces it.
const BOARD: Record<BeatId, Shot[]> = {
  cold: [
    { card: "9:00 AM.\n“It never arrived.”" },
    { cue: "Your AI agent", card: "{Wait.|Pay again.|Hand it to a person.}", per: "word" },
  ],
  stakes: [
    { card: "Pay too soon:\npaid twice." },
    { cue: "Believe an email", card: "Trust the email:\npaid a fraudster." },
    { cue: "An agent holding", card: "Raw payment keys.\nSeconds." },
  ],
  layer: [
    { logo: true },
    { cue: "The model reads", screen: "02-wait", framing: "text-left", caption: "Code decides.\nA person signs.", enter: "rise-in", move: "settle" },
    { cue: "And every step", crop: "sealedNote", move: "push-in" },
  ],
  room: [
    { screen: "01-dashboard", framing: "hero", enter: "approach", move: "turn-left" },
    { cue: "Eight supplier payouts", crop: "chart", move: "drift-left" },
    { cue: "We will follow", screen: "02-wait", framing: "headline-above", caption: "Invoice 1041 · Northwind Supply", move: "drift-up" },
  ],
  knows: [
    { card: "$25.00 · local US rail.\nSent to Northwind." },
    { cue: "Approved by", crop: "sealedRows", move: "push-in" },
    { cue: "And Northwind's email", crop: "supplier", move: "push-in" },
  ],
  waits: [
    { screen: "02-wait", framing: "sweep", move: "turn-right" },
    { cue: "The transfer has", crop: "window", move: "push-in" },
    { cue: "Replace is held", crop: "heldBack", move: "drift-right" },
    { cue: "The supplier is unhappy", card: "The answer is still:\nwait." },
  ],
  evidence: [
    { card: "Then the bank answers." },
    { cue: "On the sandbox", crop: "simulate", move: "push-in" },
    { cue: "And Airwallex cancels", screen: "05-failed", framing: "hero", enter: "approach", move: "turn-left" },
    { cue: "It reads the transfer", crop: "cancelledRows", move: "drift-left" },
  ],
  permits: [
    { screen: "05-failed", framing: "bleed", move: "drift-right", accents: ["light-sweep"] },
    { cue: "Nine one four", crop: "replaceReasons", move: "drift-up" },
    { cue: "Every one of those", card: "Proven by Airwallex.\nNot claimed." },
  ],
  replace: [
    { crop: "replaceButton", move: "push-in" },
    { cue: "The original stays", crop: "attempts", move: "drift-left" },
  ],
  retry: [
    { card: "Press it again?" },
    { cue: "A double click", card: "{A double click|A retry storm|A lost agent}", per: "word" },
    { cue: "We send the", screen: "07-retry-refused", framing: "hero", enter: "approach", move: "turn-left" },
    { cue: "Refused.", crop: "refused", move: "push-in" },
    { cue: "And underneath the", card: "One open payment.\nNever two." },
  ],
  status: [
    { screen: "08-paid-hold", framing: "sweep", move: "turn-right" },
    { cue: "A bank can", crop: "notFinal", move: "drift-right" },
    { cue: "Then it reconciles", crop: "certificate", move: "push-in" },
    { cue: "Certified, with a", screen: "10-certified", framing: "text-left", caption: "Paid once.\nCertified.", enter: "rise-in", move: "settle" },
  ],
  human: [
    { crop: "supplier", move: "drift-right" },
    { cue: "And the queue", screen: "13-queue", framing: "high", move: "push-in" },
    { cue: "One is a", crop: "duplicate", move: "push-in" },
    { cue: "Only a named", card: "A named person.\nIn writing." },
  ],
  close: [
    { card: "Wait, when it's right." },
    { cue: "Replace, when the", card: "Replace, when it's proven.\nNever twice." },
    { cue: "And a person,", card: "A person, for the rest." },
    { cue: "Tessera. Money", logo: true },
  ],
};

/** Three Ultramock projects, each well under its 180 s cap. */
export const PARTS: { name: string; beats: BeatId[] }[] = [
  { name: "Tessera · Demo Day · Part 1", beats: ["cold", "stakes", "layer", "room"] },
  { name: "Tessera · Demo Day · Part 2", beats: ["knows", "waits", "evidence", "permits"] },
  { name: "Tessera · Demo Day · Part 3", beats: ["replace", "retry", "status", "human", "close"] },
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/** Seconds into the beat's voice where `phrase` begins. */
function cueAt(beat: BeatId, phrase: string): number {
  const words = timings.beats[beat].words;
  const target = phrase.split(/\s+/).map(norm);
  for (let i = 0; i + target.length <= words.length; i++) {
    if (target.every((t, j) => norm(words[i + j]!.text) === t)) return words[i]!.start;
  }
  throw new Error(`cue "${phrase}" not spoken in beat ${beat}`);
}

const beatLength = (beat: BeatId, last: boolean) => LEAD + timings.beats[beat].duration + (last ? END_HOLD : TAIL);

const FLAT: { framing: string; move: string; device?: string }[] = [
  { framing: "screen-front", move: "push-in" },
  { framing: "hero", move: "push-in", device: "pro-display-xdr" },
  { framing: "screen", move: "settle" },
  { framing: "screen-bleed", move: "push-in" },
  { framing: "bleed", move: "push-in", device: "pro-display-xdr" },
  { framing: "sweep", move: "push-in", device: "pro-display-xdr" },
  { framing: "low", move: "settle", device: "pro-display-xdr" },
];
let flatTurn = 0;

function shotJson(s: Shot, duration: number): Record<string, unknown> {
  if ("card" in s) {
    return {
      kind: "text",
      duration,
      text: { content: s.card, size: s.size ?? (s.card.length > 24 ? 5 : 6), ...(s.per ? { per: s.per } : {}), ...(s.effect ? { effect: s.effect } : {}) },
      transition: "zoom-out",
    };
  }
  if ("logo" in s) {
    const logo = readFileSync("public/brand/tessera-mark.png").toString("base64");
    return { kind: "logo", duration, image_base64: logo, logo_enter: "blur-scale-up", logo_exit: "fade", logo_scale: 1.2, transition: "zoom-out" };
  }
  if ("crop" in s) {
    const image = images[`crop-${s.crop}`];
    if (!image) throw new Error(`no uploaded panel crop-${s.crop}`);
    // Ultramock refuses near-identical views close together, so the panels take turns among the flat framings,
    // most readable first, each with a move it accepts. (A flat `detail` zooms to one line, so panels never use it.)
    const look = FLAT[flatTurn++ % FLAT.length]!;
    return { image_upload: image, device: look.device ?? "none", framing: look.framing, duration, motion: { move: look.move }, transition: "zoom-out" };
  }
  const image = images[s.screen];
  if (!image) throw new Error(`no uploaded image for ${s.screen}`);
  const flat = s.framing.startsWith("screen");
  return {
    image_upload: image,
    device: flat ? "none" : LAPTOP,
    framing: s.framing,
    duration,
    ...(s.focus ? { focus: s.focus } : {}),
    motion: { ...(s.enter ? { enter: s.enter } : {}), ...(s.move ? { move: s.move } : {}), ...(s.exit ? { exit: s.exit } : {}), ...(s.accents ? { accents: s.accents } : {}) },
    ...(s.caption ? { captions: [{ content: s.caption }] } : {}),
    transition: "zoom-out",
  };
}

/** Lays out one part: every shot's start and length, cut on its cue, and where each beat's voice begins. */
function layout(part: (typeof PARTS)[number], lastPart: boolean) {
  const shots: Record<string, unknown>[] = [];
  const beats: { id: BeatId; start: number; voiceAt: number; length: number }[] = [];
  let t = 0;
  for (const [bi, beat] of part.beats.entries()) {
    const last = lastPart && bi === part.beats.length - 1;
    const length = beatLength(beat, last);
    beats.push({ id: beat, start: t, voiceAt: t + LEAD, length });
    const board = BOARD[beat];
    // A shot runs from its cue (a beat's first shot from the beat's start) to the next shot's cue.
    const starts = board.map((s, i) => (i === 0 ? 0 : LEAD + cueAt(beat, s.cue!) - 0.15));
    for (const [i, s] of board.entries()) {
      const end = i + 1 < board.length ? starts[i + 1]! : length;
      const d = Math.round((end - starts[i]!) * 100) / 100;
      if (d < 2) throw new Error(`${beat} shot ${i} is ${d}s; Ultramock needs 2 s or more: move or drop its cue`);
      shots.push({ name: `${beat}-${i + 1}`, ...shotJson(s, d) });
    }
    t += length;
  }
  return { shots, beats, total: t };
}

async function mcp(name: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch("https://www.ultramock.io/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  const json = JSON.parse(line ? line.slice(6) : text);
  if (json.error) throw new Error(`${name}: ${JSON.stringify(json.error)}`);
  return json.result;
}
const say = (r: any) => (r.content ?? []).map((c: any) => c.text ?? "").join("\n");

const statePath = "scripts/ultramock-projects.json";
const state: Record<string, string> = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const cut: { parts: { name: string; projectId: string | null; total: number; beats: ReturnType<typeof layout>["beats"] }[] } = { parts: [] };

for (const [pi, part] of PARTS.entries()) {
  flatTurn = 0;
  const { shots, beats, total } = layout(part, pi === PARTS.length - 1);
  console.log(`\n${part.name}: ${shots.length} shots, ${total.toFixed(1)} s`);
  if (total > 180) throw new Error(`${part.name} runs ${total.toFixed(1)} s, over Ultramock's 180 s`);
  let projectId = state[part.name] ?? null;
  if (!projectId && APPLY) {
    const first = shots.find((s) => s.image_upload) as { image_upload: string };
    const made = await mcp("generate_mockup", { image_upload: first.image_upload, device: LAPTOP, project_name: part.name, style: "dramatic" });
    projectId = made.structuredContent?.project_id ?? say(made).match(/c[a-z0-9]{20,}/)?.[0];
    if (!projectId) throw new Error(`could not read the new project id: ${say(made)}`);
    state[part.name] = projectId;
    writeFileSync(statePath, JSON.stringify(state, null, 1));
    console.log(`created ${projectId}`);
  }
  const args = {
    ...(projectId ? { project_id: projectId } : {}),
    pace: "ambient",
    style: "dark",
    format: "16:9",
    type: { family: "archivo", weight: 600 },
    fade_in: false,
    fade_out: false,
    shots,
    step_label: "demo-day build",
    ...(APPLY ? {} : { check_only: true }),
  };
  if (!projectId) {
    console.log("(no project yet: run with --apply to create it)");
  } else {
    const r = await mcp("apply_timeline", args);
    console.log(say(r).slice(0, 4000));
    if (APPLY) console.log(say(await mcp("set_look", { project_id: projectId, all_shots: true, blur: { mode: "none" }, step_label: "demo-day build" })).slice(0, 300));
  }
  // Seams can shift where a shot really starts, so the voice is placed from what Ultramock saved, not from the plan.
  if (projectId && APPLY) {
    const saved = await mcp("get_mockup", { project_id: projectId });
    const savedShots: { name?: string; start_s?: number; duration?: number }[] = saved.structuredContent?.shots ?? [];
    const byName = new Map(savedShots.map((s) => [s.name, s]));
    for (const b of beats) {
      const first = byName.get(`${b.id}-1`);
      if (first?.start_s === undefined) throw new Error(`Ultramock did not save shot ${b.id}-1`);
      const drift = first.start_s - b.start;
      if (Math.abs(drift) > 0.05) console.log(`  ${b.id}: Ultramock starts it at ${first.start_s.toFixed(2)} s (planned ${b.start.toFixed(2)})`);
      b.voiceAt = first.start_s + LEAD;
      b.start = first.start_s;
    }
    const end = Math.max(...savedShots.map((s) => (s.start_s ?? 0) + (s.duration ?? 0)));
    cut.parts.push({ name: part.name, projectId, total: end, beats });
    continue;
  }
  cut.parts.push({ name: part.name, projectId, total, beats });
}
writeFileSync("src/demo/cut.json", JSON.stringify(cut, null, 1));
console.log("\nwrote src/demo/cut.json");
