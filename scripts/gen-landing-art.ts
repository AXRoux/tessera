/**
 * Generates the landing page's photographs with fal.ai (FLUX 1.1 Pro Ultra, raw mode for real-looking people).
 *
 *   bun run scripts/gen-landing-art.ts generate [--only <plate>] [--n 2]
 *       Each plate (or one), n candidates, into $TESSERA_ART_DIR (default /tmp/tessera-landing-art), plus manifest.json.
 *   bun run scripts/gen-landing-art.ts finish <plate-i> <name>
 *       Turns that candidate into the page's cobalt duotone (navy shadows, pale-blue highlights, fine grain) and writes
 *       web/public/landing/<name>.webp.
 *
 * Reads FAL_KEY from the root .env. The key is used here only: nothing in the app or its image calls fal.
 *
 * Art direction: the Payy billboard (one full-bleed monochrome photograph of people and markets, a logo laid over it) and
 * a series of grainy editorial posters. Real people working with AI on money; textless, so the page draws every word.
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
  desk: {
    aspect: "4:3",
    prompt:
      "A treasury operations lead, a woman in her thirties with short natural hair in a dark tailored blazer, seated at a desk in a high-rise office, calmly reviewing a payment on a tablet. Beside her on the desk a sleek polished chrome robotic hand rests open, palm up, offering a single thin translucent glass card toward her, the two hands about to meet. Floor-to-ceiling windows behind with the towers of a financial district. Composition: the woman on the right half, the robotic hand and glass card in the center, calm negative space at the top left.",
  },
  signer: {
    aspect: "3:4",
    prompt:
      "Close portrait of a man in his fifties, a chief financial officer with grey stubble and rolled shirt sleeves, leaning over a desk and signing a document with a fountain pen, focused and calm, his face in three-quarter profile lit softly from a window on the right, the pen and paper sharp in the foreground. Dark background.",
  },
  crowd: {
    aspect: "4:3",
    prompt:
      "Wide street photograph of a busy financial district at morning rush: crowds of office workers in coats crossing a plaza between tall stone and glass towers, motion and depth, sunlight raking between buildings, seen from slightly above. Composition: dense crowd in the lower half, towers rising to the top.",
  },
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
  const source = join(OUT, `${id}.png`);
  mkdirSync(PUBLIC, { recursive: true });
  // Cobalt duotone, as a three-stop gradient map: shadows to deep navy, midtones to Tessera blue, highlights to a near
  // white blue. More contrast first, a fine grain last.
  const clut = join(OUT, "clut.png");
  await $`magick -size 1x128 gradient:${"#01061a-#1f63f0"} -size 1x128 gradient:${"#1f63f0-#e9f1ff"} -append -rotate -90 ${clut}`;
  const duo = join(OUT, `${name}-duo.png`);
  await $`magick ${source} -resize ${"2000x2000>"} -colorspace Gray -sigmoidal-contrast 5x45% ${clut} -clut -attenuate 0.4 +noise Gaussian ${duo}`;
  await $`cwebp -quiet -q 82 ${duo} -o ${join(PUBLIC, `${name}.webp`)}`;
  console.log(`web/public/landing/${name}.webp`);
} else {
  console.error("usage: generate [--only <plate>] [--n 2] | finish <plate-i> <name>");
  process.exit(1);
}
