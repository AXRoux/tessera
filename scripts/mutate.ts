/**
 * `bun run mutate`: proves each guard is load-bearing.
 *
 * For every entry in scripts/mutations.ts it removes ONE guard from a private copy of the repo (in the OS temp
 * directory; the real working tree is never written), then runs the red team and the named tests against the copy. A
 * guard is KILLED when everything that is supposed to notice does. SURVIVED means the guard could be removed and nothing
 * failed: a hole in the tests, and the run exits 1.
 *
 *   bun run mutate                       all mutations, with a baseline first
 *   bun run mutate -- --list             what is in the catalog
 *   bun run mutate -- --check            only check that every anchor still matches the source (fast, no runs)
 *   bun run mutate -- --only hmac-check,hold-window
 *   bun run mutate -- --no-typecheck     skip compiling each mutated copy (default: compile, so a mutation that does not build is reported INVALID)
 *   bun run mutate -- --markdown         print the README table instead of the progress lines
 *   bun run mutate -- --keep             leave the temp copy in place for debugging
 *   bun run mutate -- --timeout 180      per-command timeout in seconds (default 120)
 *
 * Offline: no keys, no network. Exit code 0 only when every mutation is KILLED.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ATTACKS } from "../tests/redteam/attacks";
import { MUTATIONS } from "./mutations";
import { applyEdits, evaluate, prepareWorkspace, readReal, removeWorkspace, run, runAttacks, runTests, StaleMutation, type Outcome } from "./mutate-lib";

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const tty = Boolean(process.stdout.isTTY || process.env.FORCE_COLOR);
const paint = (code: string, text: string) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = (t: string) => paint("1", t);
const dim = (t: string) => paint("2", t);
const green = (t: string) => paint("32", t);
const red = (t: string) => paint("31", t);
const yellow = (t: string) => paint("33", t);

const timeoutMs = Number(value("--timeout") ?? 120) * 1000;
const typecheck = !flag("--no-typecheck");
const markdown = flag("--markdown");
const only = value("--only")?.split(",").map((s) => s.trim()).filter(Boolean);
const say = (line = "") => (markdown ? undefined : console.log(line));

// ---- the catalog must describe the source it ships with -----------------------------------------------------------
const problems: string[] = [];
const ids = new Set<string>();
for (const m of MUTATIONS) {
  if (ids.has(m.id)) problems.push(`${m.id}: duplicate id`);
  ids.add(m.id);
  for (const e of m.edits) if (!existsSync(join(root, e.file))) problems.push(`${m.id}: no such file ${e.file}`);
  for (const t of m.expect.tests ?? []) if (!existsSync(join(root, t.file))) problems.push(`${m.id}: no such test file ${t.file}`);
  for (const n of m.expect.attacks ?? []) if (!Number.isInteger(n) || n < 1 || n > ATTACKS.length) problems.push(`${m.id}: attack ${n} does not exist (there are ${ATTACKS.length})`);
  if ((m.expect.attacks ?? []).length + (m.expect.tests ?? []).length === 0) problems.push(`${m.id}: expects nothing to fail`);
}
if (only) for (const id of only) if (!ids.has(id)) problems.push(`--only ${id}: no such mutation (see --list)`);

const read = readReal(root);
const originals = new Map<string, string>();
const mutatedBy = new Map<string, Map<string, string>>();
for (const m of MUTATIONS) {
  try {
    const mutated = applyEdits((file) => read(file), m.edits, m.id);
    mutatedBy.set(m.id, mutated);
    for (const file of m.edits.map((e) => e.file)) if (!originals.has(file)) originals.set(file, read(file));
  } catch (error) {
    if (!(error instanceof StaleMutation)) throw error;
    problems.push(error.message);
  }
}
if (problems.length > 0) {
  console.error(red(`\nThe mutation catalog is out of step with the source (${problems.length} problem${problems.length === 1 ? "" : "s"}):`));
  for (const p of problems) console.error(`  ${red("✗")} ${p}`);
  process.exit(1);
}

const selected = MUTATIONS.filter((m) => !only || only.includes(m.id));
const what = (m: (typeof MUTATIONS)[number]) =>
  [...(m.expect.attacks ?? []).map((n) => `attack ${n}`), ...(m.expect.tests ?? []).map((t) => (t.name ? `${t.file} > ${t.name}` : t.file))].join(", ");

if (flag("--list")) {
  for (const m of MUTATIONS) console.log(`${m.id.padEnd(30)} ${m.describe}\n${" ".repeat(31)}${dim(`must fail: ${what(m)}`)}`);
  console.log(`\n${MUTATIONS.length} mutations.`);
  process.exit(0);
}
if (flag("--check")) {
  console.log(`${green("✓")} all ${MUTATIONS.length} anchors match the source exactly once.`);
  process.exit(0);
}

// ---- a private copy, and a baseline that must be green ----------------------------------------------------------------
const ws = prepareWorkspace(root);
let finished = false;
const cleanup = () => {
  if (flag("--keep")) console.error(dim(`kept: ${ws}`));
  else removeWorkspace(ws);
};
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

try {
  say(`${bold("Tessera mutation check")}  ${dim(`${selected.length} of ${MUTATIONS.length} mutations, on a copy in ${ws}`)}\n`);

  say(dim("baseline (nothing mutated)"));
  const baseline: string[] = [];
  if (typecheck) {
    const tc = await run(["bun", "run", "typecheck"], ws, timeoutMs);
    if (tc.code !== 0) baseline.push(`typecheck fails: ${(tc.out.split("\n").find((l) => l.includes("error TS")) ?? "").trim()}`);
  }
  const base = await runAttacks(ws, timeoutMs);
  if (!base) baseline.push("the red team does not load");
  else if (base.broke.size + base.threw.size > 0) baseline.push(`attacks not holding: ${[...base.broke, ...base.threw.keys()].join(", ")}`);
  const seen = new Set<string>();
  for (const m of selected) {
    for (const t of m.expect.tests ?? []) {
      const key = `${t.file}|${t.name ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const r = await runTests(ws, t, timeoutMs);
      if (r.failed) baseline.push(`${t.file}${t.name ? ` > ${t.name}` : ""} fails before any mutation`);
      else if (r.ran === 0) baseline.push(`${t.file}${t.name ? ` > ${t.name}` : ""} matches no tests, so it could never fail`);
    }
  }
  if (baseline.length > 0) {
    console.error(red("\nThe baseline is not green, so no mutation result would mean anything:"));
    for (const b of baseline) console.error(`  ${red("✗")} ${b}`);
    process.exitCode = 2;
    throw new Error("baseline red");
  }
  say(`  ${green("✓")} ${base!.total}/${base!.total} attacks held, ${seen.size} test selection${seen.size === 1 ? "" : "s"} green${typecheck ? ", typechecks" : ""}\n`);

  // ---- one mutation at a time -------------------------------------------------------------------------------------------
  const outcomes: Outcome[] = [];
  for (const m of selected) {
    const o = await evaluate(ws, m, originals, mutatedBy.get(m.id)!, { attacks: true, typecheck, timeoutMs });
    outcomes.push(o);
    const color = o.verdict === "KILLED" ? green : o.verdict === "PARTIAL" ? yellow : red;
    say(`${color(o.verdict.padEnd(8))} ${m.id.padEnd(30)} ${dim(`${(o.ms / 1000).toFixed(1)}s`)}  ${m.describe}`);
    if (o.verdict === "KILLED") say(dim(`           caught by: ${o.caught.join(", ")}`));
    else {
      if (o.caught.length > 0) say(dim(`           caught by: ${o.caught.join(", ")}`));
      if (o.missed.length > 0) say(red(`           NOT caught by: ${o.missed.join(", ")}`));
      if (o.note) say(red(`           ${o.note}`));
    }
    if (o.threw.length > 0) say(yellow(`           note: attack ${o.threw.map(([n]) => n).join(", ")} threw instead of reporting (${o.threw[0]![1]}); counted as failing`));
    if (o.unexpected.length > 0) say(dim(`           also broke (shared guard): attack ${o.unexpected.join(", ")}`));
  }
  // ---- summary --------------------------------------------------------------------------------------------------------------
  const killed = outcomes.filter((o) => o.verdict === "KILLED").length;
  const covered = new Set(selected.flatMap((m) => m.expect.attacks ?? []));
  const uncovered = ATTACKS.map((_, i) => i + 1).filter((n) => !covered.has(n));

  if (markdown) {
    console.log("| Break | What caught it |\n|---|---|");
    for (const [i, m] of selected.entries()) {
      const o = outcomes[i]!;
      console.log(`| ${m.describe} | ${o.verdict === "KILLED" ? o.caught.map((c) => c.replace(/^tests\//, "").replace(" > ", ": ")).join("; ") : `**${o.verdict}**: ${o.missed.join("; ") || o.note}`} |`);
    }
    console.log(`\n${killed}/${outcomes.length} mutations killed.`);
  } else {
    say(`\n${killed === outcomes.length ? green("PASS") : red("FAIL")}  ${killed}/${outcomes.length} mutations killed`);
    if (!only) {
      if (uncovered.length > 0) say(dim(`attacks with no mutation aimed at them: ${uncovered.map((n) => `${n} (${ATTACKS[n - 1]!.title})`).join("; ")}`));
      else say(dim("every attack has at least one mutation aimed at it"));
    }
  }
  finished = killed === outcomes.length;
} catch (error) {
  if ((error as Error).message !== "baseline red") {
    console.error(red(`\n${(error as Error).stack ?? String(error)}`));
    process.exitCode = 2;
  }
} finally {
  cleanup();
}
process.exit(finished ? 0 : process.exitCode || 1);
