/**
 * Generates the artwork for the sign-up card with fal.ai, then upscales the chosen plates for the web.
 *
 *   bun run scripts/gen-card-art.ts generate [--only <look>] [--n 3]
 *       Every look (or one), n candidates each, into $TESSERA_ART_DIR (default /tmp/tessera-card-art), with a contact
 *       sheet (sheet.jpg) and manifest.json (each candidate's fal URL and seed).
 *   bun run scripts/gen-card-art.ts finish <look-i> <name> [--gravity center|east|west|north|south]
 *       Upscales that candidate (Clarity, detail-preserving), crops it to the card's 1.586 ratio and writes
 *       web/public/cards/<name>.webp at 2000 px wide, and <name>-1000.webp for phones.
 *
 * Reads FAL_KEY from the root .env. The key is used here only: nothing in the app or its image calls fal.
 *
 * Art direction: two references. A set of dark cards (liquid chrome with oil-slick iridescence, a lava cave behind
 * wildflowers) and a series of grainy editorial posters (black and off-white, a glowing orange, red or cobalt
 * gradient, brutalist concrete, the moon, an x-ray flower). Every plate is textless: the card's writing, chip and
 * Visa mark are drawn by the page, crisp, and a model would garble them. The left and lower-left stay calm and dark,
 * where the card number and name sit.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const ROOT = join(import.meta.dir, "..");
const OUT = process.env.TESSERA_ART_DIR ?? "/tmp/tessera-card-art";
const PUBLIC = join(ROOT, "web/public/cards");
const KEY = process.env.FAL_KEY;
if (!KEY) {
  console.error("FAL_KEY is missing: add it to the root .env");
  process.exit(1);
}

/** Said of every plate, so none comes back as a picture of a card, or with writing on it. */
const FRAME =
  "Full-bleed artwork that fills the entire frame edge to edge, horizontal composition. Absolutely no text, no letters, no numbers, no logos, no watermark, no credit card, no borders, no frame, no mockup. The left third and the lower-left are calm and dark, quiet negative space. Premium, editorial, ultra detailed, sharp micro texture.";

const LOOKS: Record<string, string> = {
  chrome:
    "Macro photograph of molten black chrome flowing in slow marbled ribbons, polished mirror ridges catching thin iridescent oil-slick light, bands of violet, teal, copper and pale gold along the crests, the richest swirl in the upper right, deep velvety black elsewhere. High-end product photography, studio lighting, subtle film grain.",
  lava:
    "Cinematic landscape photograph from inside a black basalt lava cave: through the jagged cave opening a river of glowing orange-red lava crosses a dark volcanic plain under a grey overcast sky. Foreground of soft green moss and tiny white wildflowers, the nearest blossoms heavily out of focus. Moody, low-key, the cave rock framing the left and bottom in near black. Shot on medium format, natural light.",
  prism:
    "A sweeping spectral light leak on pure black: prismatic rainbow refraction streaks bending through dark glass like liquid, cobalt blue dominant fading to cyan, a sliver of warm red at the edge, chromatic aberration, soft bloom, smooth black flowing contours. Abstract, analogue photograph, fine grain.",
  ember:
    "Abstract grainy gradient: a soft glowing blaze of orange and red light rising from the lower right into deep black, blurred like long-exposure light painting, heavy risograph film grain and halftone noise, warm haze, editorial poster aesthetic, minimal.",
  concrete:
    "Black and white photograph of brutalist concrete architecture, abstract stacked cubic volumes and deep shadows, harsh raking sunlight, seen from below, high contrast, heavy film grain and risograph halftone texture, off-white highlights, editorial poster aesthetic.",
  moon:
    "Grainy black and white photograph of the moon: its curved cratered limb fills the right side of the frame, lit from the right, falling into deep black space on the left with a few faint stars. Heavy film grain, risograph print texture, high contrast, editorial poster aesthetic.",
  xray:
    "X-ray radiograph of a single lily flower on pure black, translucent luminous white petals and fine veins, ghostly and delicate, the flower on the right side of the frame, fine film grain, minimal, museum quality.",
};

type Candidate = { look: string; index: number; url: string; seed: number; width: number; height: number };

async function fal<T>(model: string, input: unknown): Promise<T> {
  const headers = { Authorization: `Key ${KEY}`, "content-type": "application/json" };
  const queued = (await (await fetch(`https://queue.fal.run/${model}`, { method: "POST", headers, body: JSON.stringify(input) })).json()) as {
    status_url?: string;
    response_url?: string;
    detail?: unknown;
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

function manifest(): Candidate[] {
  const path = join(OUT, "manifest.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Candidate[]) : [];
}

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

async function generate() {
  mkdirSync(OUT, { recursive: true });
  const only = flag("only");
  const n = Number(flag("n") ?? 3);
  const looks = Object.entries(LOOKS).filter(([look]) => !only || only.split(",").includes(look));
  const kept = manifest().filter((c) => !looks.some(([look]) => look === c.look));
  const made = await Promise.all(
    looks.flatMap(([look, prompt]) =>
      Array.from({ length: n }, async (_, index) => {
        const result = await fal<{ images: { url: string; width: number; height: number }[]; seed: number }>("fal-ai/flux-pro/v1.1-ultra", {
          prompt: `${prompt} ${FRAME}`,
          aspect_ratio: "3:2",
          raw: true,
          num_images: 1,
          output_format: "jpeg",
          safety_tolerance: "2",
        });
        const image = result.images[0]!;
        const file = join(OUT, `${look}-${index}.jpg`);
        await Bun.write(file, await (await fetch(image.url)).arrayBuffer());
        console.log(`  ${look}-${index}  ${image.width}x${image.height}`);
        return { look, index, url: image.url, seed: result.seed, width: image.width, height: image.height } satisfies Candidate;
      }),
    ),
  );
  const all = [...kept, ...made].sort((a, b) => a.look.localeCompare(b.look) || a.index - b.index);
  writeFileSync(join(OUT, "manifest.json"), JSON.stringify(all, null, 2));
  // A contact sheet, one row per look, each tile labelled, to choose from.
  const tiles = all.map((c) => join(OUT, `${c.look}-${c.index}.jpg`));
  await $`magick montage -label %t ${tiles} -resize 600x400 -geometry +8+8 -tile ${n}x -background #111 -fill #ddd -pointsize 18 ${join(OUT, "sheet.jpg")}`.quiet();
  console.log(`\n${all.length} candidates; contact sheet: ${join(OUT, "sheet.jpg")}`);
}

async function finish() {
  const [pick, name] = process.argv.slice(3);
  if (!pick || !name) throw new Error("usage: finish <look-i> <name> [--gravity center]");
  const candidate = manifest().find((c) => `${c.look}-${c.index}` === pick);
  if (!candidate) throw new Error(`no candidate ${pick} in ${OUT}/manifest.json`);
  const gravity = flag("gravity") ?? "center";
  // Clarity adds real detail as it enlarges; a low creativity keeps the plate the one that was chosen.
  const up = await fal<{ image: { url: string; width: number; height: number } }>("fal-ai/clarity-upscaler", {
    image_url: candidate.url,
    upscale_factor: 1.5,
    prompt: `${LOOKS[candidate.look]} masterpiece, best quality, highres, sharp`,
    negative_prompt: "text, letters, watermark, blurry, jpeg artifacts, lowres",
    creativity: 0.25,
    resemblance: 0.75,
    num_inference_steps: 22,
  });
  const raw = join(OUT, `${pick}-up.png`);
  await Bun.write(raw, await (await fetch(up.image.url)).arrayBuffer());
  mkdirSync(PUBLIC, { recursive: true });
  const out = join(PUBLIC, `${name}.webp`);
  // The card is 1.586:1 (ISO/IEC 7810 ID-1). 2000 px wide covers the card's 500 CSS px at four times over.
  await $`magick ${raw} -gravity ${gravity} -crop ${"%[fx:min(w,h*1.586)]"}x${"%[fx:min(h,w/1.586)]"}+0+0 +repage -resize 2000x1261! -strip ${raw}.crop.png`.quiet();
  await $`cwebp -quiet -q 84 -m 6 -sharp_yuv ${raw}.crop.png -o ${out}`;
  // And a 1000 px one, for phones and the 1x screens (the card's srcset picks).
  await $`magick ${raw}.crop.png -resize 1000x631! ${raw}.1000.png`.quiet();
  await $`cwebp -quiet -q 82 -m 6 -sharp_yuv ${raw}.1000.png -o ${join(PUBLIC, `${name}-1000.webp`)}`;
  const size = (await Bun.file(out).arrayBuffer()).byteLength;
  console.log(`${pick} -> ${out} (${up.image.width}x${up.image.height} upscaled, ${Math.round(size / 1024)} KB)`);
}

const command = process.argv[2];
if (command === "generate") await generate();
else if (command === "finish") await finish();
else {
  console.error("usage: bun run scripts/gen-card-art.ts generate [--only look,look] [--n 3] | finish <look-i> <name> [--gravity center]");
  process.exit(1);
}
