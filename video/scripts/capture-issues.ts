// Records the supplier-issues walkthrough as 4K frames, for the film (src/issues). Runs the real console against the
// real API (start it first, e.g. live on the Airwallex sandbox with a fresh ledger), performs every step a presenter
// would, and saves a 3840x2160 frame at each moment plus time-lapse bursts while the agent works. It also records where
// each button and panel sits, so the film's camera and cursor go exactly where the real ones did.
//
//   TESSERA_DB=.data/film.db TESSERA_OPERATOR=ops@acme.co bun run dev     (repo root)
//   bun run scripts/capture-issues.ts                                     (video/)
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium, type Locator, type Page } from "playwright-core";

const BASE = process.env.CONSOLE_URL ?? "http://127.0.0.1:3100";
const OUT = "public/film";
const EXE = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1255/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
mkdirSync(OUT, { recursive: true });

type Rect = { x: number; y: number; w: number; h: number };
const shots: Record<string, { file: string; rects: Record<string, Rect>; at: number }> = {};
const bursts: Record<string, string[]> = {};
const t0 = Date.now();
const log = (s: string) => console.log(`${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s  ${s}`);

const browser = await chromium.launch({ executablePath: EXE });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
await ctx.addCookies([{ name: "tessera-theme", value: "dark", url: BASE }]);
const page = await ctx.newPage();
page.on("pageerror", (e) => log(`pageerror ${e.message}`));

async function rectOf(l: Locator): Promise<Rect | null> {
  const b = await l.boundingBox({ timeout: 2500 }).catch(() => null);
  return b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null;
}

/** A 4K frame, with the rects (CSS pixels) of the named targets in it. */
async function shot(name: string, targets: Record<string, Locator> = {}, settle = 900) {
  await page.waitForTimeout(settle);
  const rects: Record<string, Rect> = {};
  for (const [k, l] of Object.entries(targets)) {
    const r = await rectOf(l.first());
    if (r) rects[k] = r;
  }
  const file = `${OUT}/${name}.png`;
  await page.screenshot({ path: file });
  shots[name] = { file: `film/${name}.png`, rects, at: Date.now() - t0 };
  log(`shot ${name}`);
}

/** Frames every `every` ms until `done()` says stop (or the time runs out): a time-lapse of something happening. */
async function burst(name: string, done: () => Promise<boolean>, every = 1400, max = 240_000) {
  const files: string[] = [];
  const start = Date.now();
  for (let i = 0; Date.now() - start < max; i++) {
    const file = `${OUT}/${name}-${String(i).padStart(3, "0")}.png`;
    await page.screenshot({ path: file });
    files.push(`film/${name}-${String(i).padStart(3, "0")}.png`);
    if (await done()) break;
    await page.waitForTimeout(every);
  }
  bursts[name] = files;
  log(`burst ${name}: ${files.length} frames`);
}

const api = (path: string, init?: { method?: string; body?: unknown }) =>
  page.evaluate(
    async ({ path, init }) => {
      const r = await fetch(`/api/${path}`, { method: init?.method ?? "GET", headers: { "content-type": "application/json" }, body: init?.body === undefined ? undefined : JSON.stringify(init.body) });
      return r.json();
    },
    { path, init },
  );
type Item = { id: string; reference: string; status: string; supplier?: { name: string }; case?: { outcome: { state: string; confirmable?: boolean } } };
const items = async (): Promise<Item[]> => ((await api("obligations")) as { items: Item[] }).items;
const idOf = async (supplier: string) => (await items()).find((i) => i.supplier?.name === supplier)!.id;
const stateOf = async (supplier: string) => (await items()).find((i) => i.supplier?.name === supplier)?.case?.outcome.state;
const agentIdle = async () => (await page.getByText("Agent standing by").count()) > 0;
/** Starts watching an agent run: waits until it is visibly working, so a time-lapse never ends before it begins. */
const agentStarted = () => page.getByText("Agent working").first().waitFor({ timeout: 30_000 }).catch(() => log("never saw the agent start"));
async function until(what: string, test: () => Promise<boolean>, max = 180_000) {
  const start = Date.now();
  while (Date.now() - start < max) {
    if (await test()) return;
    await page.waitForTimeout(2000);
  }
  log(`gave up waiting for ${what}`);
}

const dashboard = async () => {
  await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
};
const globe = () => page.locator("canvas.cursor-grab");
const pin = (name: string) => page.getByRole("button", { name: new RegExp(`^${name},`) });
async function openPin(name: string) {
  const b = (await globe().boundingBox())!;
  await page.mouse.move(b.x + b.width * 0.85, b.y + b.height * 0.1);
  await page.waitForTimeout(300);
  await pin(name).click();
  await page.waitForTimeout(1400);
  await page.mouse.move(5, 5);
}
const card = () => page.getByRole("article").first();
const cardScroll = (to: "top" | "bottom") =>
  card().locator(".thin-scroll").first().evaluate((el, to) => el.scrollTo({ top: to === "top" ? 0 : el.scrollHeight }), to);

// 1. Where the walkthrough starts: the supplier issues, waiting.
await dashboard();
await shot("preload", {
  investigate: page.getByRole("button", { name: "Investigate supplier issues" }).last(),
  title: page.getByRole("heading", { name: "Supplier issues" }),
  globe: globe(),
}, 2500);

// 2. Investigate: the issues open on the sandbox.
await page.getByRole("button", { name: "Investigate supplier issues" }).last().click();
await until("the supplier issues to open", async () => (await items()).filter((i) => i.case).length >= 6, 240_000);
await dashboard();
await page.waitForTimeout(1500);
await shot("loaded", {
  title: page.getByRole("heading", { name: "Supplier issues" }),
  globe: globe(),
  sf: pin("Replicate"),
  modal: pin("Modal"),
  framer: pin("Framer"),
  run: page.getByRole("button", { name: /Let the agent work/ }),
  plan: page.getByText("It will work").locator(".."),
}, 1500);

// 3. The agent works the issues: a time-lapse of its reasoning, the pins turning as it goes.
await page.getByRole("button", { name: /Let the agent work/ }).click();
await agentStarted();
await burst("run", agentIdle, 1300, 400_000);
await shot("worked", { globe: globe(), agent: page.getByRole("region", { name: "The agent" }), live: page.getByRole("region", { name: "Live activity" }) }, 2500);

// 4. Framer: investigated, impostor stopped.
await openPin("Framer");
await shot("framer-card", { card: card() });
await cardScroll("bottom");
await shot("framer-card-found", { card: card() }, 700);
const framer = await idOf("Framer");
await page.goto(`${BASE}/incidents/${framer}`, { waitUntil: "networkidle" });
await page.getByRole("tab", { name: /Supplier/ }).click();
await page.getByText("What the investigation found").first().scrollIntoViewIfNeeded();
await shot("framer-investigation", { report: page.getByText("What the investigation found").first().locator("../..") }, 1200);
await page.getByRole("tab", { name: /History/ }).click();
await shot("framer-history", {}, 1000);

// 5. Prime Intellect: held, and the guardrail test on it while it is still in transit.
await dashboard();
await openPin("Prime Intellect");
await shot("pi-card", { card: card() });
await page.getByRole("button", { name: "Close" }).first().click();
await page.waitForTimeout(500);
const pi = (await items()).find((i) => i.supplier?.name === "Prime Intellect")!;
const guard = page.getByLabel("Test the guardrails on");
if ((await guard.count()) > 0) {
  await guard.click();
  await page.getByRole("option", { name: new RegExp(pi.reference) }).click().catch(() => undefined);
  await page.waitForTimeout(400);
}
await shot("guard-ready", { test: page.getByRole("button", { name: "Test" }), select: guard });
await page.getByRole("button", { name: "Test" }).click();
await agentStarted();
await burst("guard", agentIdle, 1300, 300_000);
await shot("guard-done", { agent: page.getByRole("region", { name: "The agent" }) }, 1500);

// 6. Replicate: fixed by the agent alone.
await openPin("Replicate");
await page.getByRole("tab", { name: /Trail/ }).click();
await shot("replicate-trail", { card: card() });

// 7. Modal: the Visa card, authorized by a person, paid by the agent through Visa TAP.
const modal = await idOf("Modal");
await page.goto(`${BASE}/queue?id=${modal}`, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
const note = page.getByPlaceholder(/Called the supplier on the number we hold/);
await note.scrollIntoViewIfNeeded();
await shot("queue-modal", { note, card: page.getByText("Pay by Visa card").first().locator(".."), sign: page.getByRole("button", { name: /^Sign as/ }) });
await note.fill("Called Modal on the number we hold; they take card for this invoice.");
await shot("queue-modal-note", { note, sign: page.getByRole("button", { name: /^Sign as/ }) }, 500);
await page.getByRole("button", { name: /^Sign as/ }).click();
await page.waitForTimeout(2000);
await shot("queue-modal-signed", {}, 500);
await until("the agent to pay Modal", async () => (await agentIdle()) && (await stateOf("Modal")) !== "yours", 240_000);
await shot("queue-modal-paid", {}, 1500);

// 8. LangChain: a second payment only a person can release, in writing.
const lc = await idOf("LangChain");
await page.goto(`${BASE}/queue?id=${lc}`, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await page.getByText("Pay again, in writing").first().click();
const why = page.getByPlaceholder(/The supplier's bank confirmed by phone/);
await why.scrollIntoViewIfNeeded();
await why.fill("Called LangChain: the first payment never reached them, so we release it once.");
await shot("queue-lc", { why }, 500);
await page.getByRole("button", { name: "Review before signing" }).click();
await shot("queue-lc-review", { sign: page.getByRole("button", { name: /^Sign as/ }) }, 700);
await page.getByRole("button", { name: /^Sign as/ }).click();
await page.waitForTimeout(2500);
await shot("queue-lc-signed", {}, 500);

// 9. fal and Framer: paid, and the supplier's word is settled by a person.
await dashboard();
await openPin("fal");
await shot("fal-card", { card: card(), received: page.getByRole("button", { name: "Mark it received" }) });
await page.getByRole("button", { name: "Mark it received" }).click();
await page.waitForTimeout(4500);
await shot("fal-received", { card: card() });
await page.getByRole("button", { name: "Close" }).first().click();
await openPin("Framer");
await cardScroll("bottom");
await page.getByRole("button", { name: "Mark it received" }).click().catch(() => log("no received button on Framer"));
await page.waitForTimeout(4500);
await page.getByRole("button", { name: "Close" }).first().click().catch(() => undefined);

// 10. Prime Intellect lands by itself; a person confirms it with them.
await until("Prime Intellect to land", async () => (await items()).find((i) => i.supplier?.name === "Prime Intellect")?.case?.outcome.confirmable === true, 240_000);
await dashboard();
await openPin("Prime Intellect");
await shot("pi-landed", { card: card(), received: page.getByRole("button", { name: "Mark it received" }) });
await page.getByRole("button", { name: "Mark it received" }).click().catch(() => undefined);
await page.waitForTimeout(3000);
await page.getByRole("button", { name: "Close" }).first().click().catch(() => undefined);

// 11. Everything settles: certified on its own.
await dashboard();
await burst("settle", async () => (await items()).filter((i) => i.case).every((i) => i.case!.outcome.state === "certified"), 5000, 300_000);
await dashboard();
await page.waitForTimeout(2500);
await shot("all-green", { title: page.getByRole("heading", { name: "Supplier issues" }), globe: globe() });
await openPin("Modal");
await page.getByRole("tab", { name: /Trail/ }).click();
await shot("modal-trail", { card: card() });
await page.getByRole("button", { name: "Close" }).first().click();
await page.getByRole("button", { name: /See all activity/ }).click();
await shot("history", { dialog: page.getByRole("dialog", { name: "Activity history" }) }, 1200);
await page.keyboard.press("Escape");
await page.mouse.click(5, 300);
await page.getByRole("tab", { name: "Lanes" }).click();
await shot("lanes", {}, 1500);
await page.goto(`${BASE}/incidents/${modal}`, { waitUntil: "networkidle" });
await page.getByRole("tab", { name: /Certificate/ }).click();
await shot("certificate", {}, 1500);

writeFileSync("src/issues/shots.json", JSON.stringify({ dpr: 2, shots, bursts }, null, 1));
log("done");
await browser.close();
