/**
 * Generates the landing page's billboard picture with fal.ai (FLUX 1.1 Pro Ultra, raw mode, for real-looking people),
 * then prints it: a cobalt halftone, the way the reference billboard prints its crowd in green.
 *
 *   bun run scripts/gen-landing-art.ts generate [--only <plate>] [--n 3]
 *       Each plate (or one), n candidates, into $TESSERA_ART_DIR (default /tmp/tessera-landing-art), plus manifest.json.
 *   bun run scripts/gen-landing-art.ts finish <plate-i> <name>
 *       Paints out any signage listed for that candidate (a model writes gibberish on street signs), then turns it
 *       into a four-tone halftone mapped navy -> cobalt -> sky and writes web/public/landing/<name>.webp (lossless).
 *
 * Reads FAL_KEY from the root .env. The key is used here only: nothing in the app or its image calls fal.
 *
 * Art direction: the Payy billboard (a ruled white face beside one full-bleed duotone picture of a crowd in a financial
 * district, the mark laid over it) and a series of grainy editorial posters. People and an agent, side by side, on
 * their way to work. Textless: the page draws every word.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const ROOT = join(import.meta.dir, "..");
const OUT = process.env.TESSERA_ART_DIR ?? "/tmp/tessera-landing-art";
const PUBLIC = join(ROOT, "web/public/landing");
const KEY = process.env.FAL_KEY;
if (!KEY) {
  console.error("FAL_KEY is missing: add it to the root .env");
  process.exit(1);
}

const FRAME =
  "Black and white editorial photograph, high contrast, deep blacks, fine film grain, shot on medium format, natural window light, documentary realism, real people with natural skin texture. Absolutely no text, no letters, no numbers, no logos, no watermark, no screens showing readable writing, no borders.";

const PLATES: Record<string, { prompt: string; aspect: string }> = {
  // The billboard's picture: people and an agent in a financial district, the reference's crowd and towers.
  pair: {
    aspect: "4:3",
    prompt:
      "Street photograph taken from behind at shoulder height in a financial district at morning rush hour. In the foreground, seen from behind and in sharp focus, a businesswoman in a long dark coat walks side by side with a tall sleek humanoid robot with a smooth white and chrome body, in step, shoulder to shoulder, each carrying a slim briefcase. Around and ahead of them a dense crowd of office workers in coats walks away from the camera across a wide plaza toward towering stone bank buildings with columns and glass skyscrapers. Low morning sun rakes between the towers, long shadows, light haze, deep perspective.",
  },
  crowd: {
    aspect: "4:3",
    prompt:
      "High-angle photograph of a dense crowd of office workers in coats crossing a wide plaza in a financial district between grand stone bank buildings with columns and tall glass towers. Several sleek white humanoid robots walk among the people in the crowd, side by side with them. Strong low sunlight, long shadows, deep perspective, vintage documentary look.",
  },
  floor: {
    aspect: "4:3",
    prompt:
      "Documentary photograph of a busy treasury operations floor in a bank: people in shirts and jackets working at long desks, in the centre a woman analyst and a sleek white humanoid robot stand side by side studying the same sheet of paper she holds, colleagues around them in conversation, tall windows with skyscrapers behind, daylight.",
  },
};

/** Boxes of gibberish signage to paint out, per chosen candidate: [width, height, x, y, filter size]. */
const SIGNAGE: Record<string, [number, number, number, number, number][]> = {
  "pair-1": [
    [140, 95, 0, 772, 17], [85, 50, 622, 882, 13], [70, 145, 744, 813, 15], [52, 90, 987, 878, 13], [52, 70, 1182, 903, 13],
    [44, 30, 1053, 970, 9], [48, 92, 1751, 863, 13], [70, 132, 1804, 806, 15], [98, 168, 1956, 738, 19], [170, 318, 2172, 478, 27],
    [90, 60, 1500, 920, 11], [46, 34, 1673, 1022, 9], [26, 262, 1703, 516, 11],
  ],
};

type Candidate = { plate: string; index: number; url: string; seed: number; width: number; height: number };

async function fal<T>(model: string, input: unknown): Promise<T> {
  const headers = { Authorization: `Key ${KEY}`, "content-type": "application/json" };
  const queued = (await (await fetch(`https://queue.fal.run/${model}`, { method: "POST", headers, body: JSON.stringify(input) })).json()) as {
    status_url?: string;
    response_url?: string;
  };
  if (!queued.status_url || !queued.response_url) throw new Error(`fal refused ${model}: ${JSON.stringify(queued).slice(0, 300)}`);
  for (;;) {
    await Bun.sleep(2000);
    const status = (await (await fetch(queued.status_url, { headers })).json()) as { status: string };
    if (status.status === "COMPLETED") break;
    if (status.status !== "IN_QUEUE" && status.status !== "IN_PROGRESS") throw new Error(`fal ${model}: ${JSON.stringify(status).slice(0, 300)}`);
  }
  const result = (await (await fetch(queued.response_url, { headers })).json()) as T & { detail?: unknown };
  if (result.detail) throw new Error(`fal ${model}: ${JSON.stringify(result.detail).slice(0, 300)}`);
  return result;
}

const manifestPath = join(OUT, "manifest.json");
const manifest = (): Candidate[] => (existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, "utf8")) as Candidate[]) : []);
const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

const command = process.argv[2];
mkdirSync(OUT, { recursive: true });

if (command === "generate") {
  const only = flag("only");
  const n = Number(flag("n") ?? 2);
  const all = manifest().filter((c) => !only || c.plate !== only);
  for (const [plate, { prompt, aspect }] of Object.entries(PLATES)) {
    if (only && plate !== only) continue;
    const jobs = Array.from({ length: n }, async (_, index) => {
      const result = await fal<{ images: { url: string; width: number; height: number }[]; seed: number }>("fal-ai/flux-pro/v1.1-ultra", {
        prompt: `${prompt} ${FRAME}`,
        aspect_ratio: aspect,
        raw: true,
        output_format: "png",
        safety_tolerance: "2",
      });
      const image = result.images[0]!;
      await $`curl -sL ${image.url} -o ${join(OUT, `${plate}-${index}.png`)}`;
      console.log(`${plate}-${index}  ${image.width}x${image.height}`);
      return { plate, index, url: image.url, seed: result.seed, width: image.width, height: image.height };
    });
    all.push(...(await Promise.all(jobs)));
  }
  writeFileSync(manifestPath, JSON.stringify(all, null, 2));
} else if (command === "finish") {
  const [id, name] = [process.argv[3], process.argv[4]];
  if (!id || !name) throw new Error("usage: finish <plate-i> <name>");
  mkdirSync(PUBLIC, { recursive: true });
  // Street signs and banners come back with gibberish lettering. Each listed box (w h x y, then the filter size, in the
  // candidate's own pixels) is flattened to its darkest tone, which leaves a plain dark sign or banner.
  const clean = join(OUT, `${name}-clean.png`);
  await $`cp ${join(OUT, `${id}.png`)} ${clean}`;
  for (const [w, h, x, y, n] of SIGNAGE[id] ?? []) {
    await $`magick ${clean} ${"("} +clone -crop ${`${w}x${h}+${x}+${y}`} +repage -statistic Minimum ${`${n}x${n}`} -blur 0x2 ${")"} -geometry ${`+${x}+${y}`} -composite ${clean}`;
  }
  // Four tones through an angled halftone screen, then a three-stop map: deep navy, Tessera cobalt, sky.
  const clut = join(OUT, "clut.png");
  await $`magick -size 1x128 gradient:${"#020838-#1340d8"} -size 1x128 gradient:${"#1340d8-#7ab8ff"} -append -rotate -90 ${clut}`;
  const print = join(OUT, `${name}-print.png`);
  await $`magick ${clean} -resize 2000x -colorspace Gray -level ${"0%,100%,0.7"} -sigmoidal-contrast 5x50% -unsharp 0x1.5 -ordered-dither h8x8a,4 ${clut} -clut ${print}`;
  await $`cwebp -quiet -lossless -z 9 ${print} -o ${join(PUBLIC, `${name}.webp`)}`;
  console.log(`web/public/landing/${name}.webp`);
} else {
  console.error("usage: generate [--only <plate>] [--n 2] | finish <plate-i> <name>");
  process.exit(1);
}
