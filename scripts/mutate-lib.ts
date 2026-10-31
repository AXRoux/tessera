/**
 * The mechanics of `bun run mutate`: apply one guard removal to a private copy of the repo, run the checks that are
 * supposed to notice, and say whether any did. Kept apart from the CLI so the mechanics can be tested on a tiny fixture.
 *
 * Nothing here ever writes to the real working tree. Every mutation is applied to a copy in the OS temp directory.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

export interface Edit {
  file: string;
  /** Must occur exactly once in `file`. If it does not, the source has drifted and the catalog is stale. */
  find: string;
  replace: string;
}

export interface Expect {
  /** Attack numbers (tests/redteam/attacks.ts, 1-based) that must stop holding under the mutation. */
  attacks?: number[];
  /** Test files (optionally narrowed to tests whose name contains `name`) in which at least one test must fail. */
  tests?: Array<{ file: string; name?: string }>;
}

export interface Mutation {
  id: string;
  describe: string;
  edits: Edit[];
  expect: Expect;
}

export class StaleMutation extends Error {
  constructor(readonly mutationId: string, message: string) {
    super(`${mutationId}: ${message}`);
    this.name = "StaleMutation";
  }
}

export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count++;
  return count;
}

/** Applies one edit, which must match exactly once. 0 or 2+ matches mean the catalog no longer describes the source. */
export function applyEdit(source: string, edit: Edit, mutationId: string): string {
  const seen = countOccurrences(source, edit.find);
  if (seen !== 1) {
    throw new StaleMutation(
      mutationId,
      `${edit.file}: expected the anchor to occur exactly once but it occurs ${seen} time(s): ${JSON.stringify(edit.find.slice(0, 90))}. The source changed; update scripts/mutations.ts.`,
    );
  }
  if (edit.find === edit.replace) throw new StaleMutation(mutationId, `${edit.file}: the replacement is identical to the anchor, so nothing would change`);
  return source.replace(edit.find, () => edit.replace);
}

/** The mutated content of every file a mutation touches. Several edits to one file are applied in order. */
export function applyEdits(read: (file: string) => string, edits: Edit[], mutationId: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const edit of edits) out.set(edit.file, applyEdit(out.get(edit.file) ?? read(edit.file), edit, mutationId));
  return out;
}

// ---- classification ---------------------------------------------------------------------------------------------

export interface Observed {
  /** Attacks that ran and reported they were NOT stopped. */
  broke: ReadonlySet<number>;
  /** Attacks that threw while running: the attack failed, but not necessarily because of the guard. */
  threw: ReadonlySet<number>;
  /** Per expected test (by index into `expect.tests`): did at least one test in it fail? */
  testsFailed: ReadonlyArray<boolean>;
}

export type Verdict = "KILLED" | "PARTIAL" | "SURVIVED";

export function classify(expect: Expect, observed: Observed): { verdict: Verdict; caught: string[]; missed: string[] } {
  const caught: string[] = [];
  const missed: string[] = [];
  for (const n of expect.attacks ?? []) (observed.broke.has(n) || observed.threw.has(n) ? caught : missed).push(`attack ${n}`);
  for (const [i, t] of (expect.tests ?? []).entries()) (observed.testsFailed[i] ? caught : missed).push(`${t.file}${t.name ? ` > ${t.name}` : ""}`);
  const verdict: Verdict = missed.length === 0 ? "KILLED" : caught.length === 0 ? "SURVIVED" : "PARTIAL";
  return { verdict, caught, missed };
}

// ---- running things in the copy ---------------------------------------------------------------------------------

export interface RunResult {
  code: number | null;
  out: string;
  timedOut: boolean;
}

/** Nothing run here may reach a real service: strip the keys a script could use, whatever the caller's shell holds. */
const SAFE_ENV = { ANTHROPIC_API_KEY: "", AWX_CLIENT_ID: "", AWX_API_KEY: "", AWX_WEBHOOK_SECRET: "", CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" };

export async function run(cmd: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
  const started = Date.now();
  const proc = Bun.spawn(cmd, { cwd, env: { ...process.env, ...SAFE_ENV }, stdout: "pipe", stderr: "pipe", timeout: timeoutMs, killSignal: "SIGKILL" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out: `${stdout}\n${stderr}`, timedOut: Date.now() - started >= timeoutMs && proc.signalCode !== null };
}

export function parseBunTest(out: string): { pass: number; fail: number } {
  const num = (re: RegExp) => Number(re.exec(out)?.[1] ?? 0);
  return { pass: num(/^\s*(\d+) pass\s*$/m), fail: num(/^\s*(\d+) fail\s*$/m) };
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function runTests(ws: string, t: { file: string; name?: string }, timeoutMs: number): Promise<{ failed: boolean; ran: number; timedOut: boolean }> {
  const args = ["bun", "test", t.file, ...(t.name ? ["-t", escapeRegex(t.name)] : [])];
  const result = await run(args, ws, timeoutMs);
  const { pass, fail } = parseBunTest(result.out);
  // A timeout or a crash that reports no tests is a failure of the checked behaviour, not a pass.
  return { failed: fail > 0 || result.timedOut || (result.code !== 0 && pass === 0), ran: pass + fail, timedOut: result.timedOut };
}

/**
 * Runs every red team attack on its own, so one attack that throws (a mutation can break the world an attack builds)
 * does not hide the verdicts of the rest. Printed as one marked JSON line.
 */
export const ATTACK_HARNESS = `import { ATTACKS } from "../tests/redteam/attacks";
const results: Array<{ n: number; status: string; error?: string }> = [];
for (const [i, attack] of ATTACKS.entries()) {
  try {
    const r = await attack.run();
    results.push({ n: i + 1, status: r.held ? "HELD" : "BROKE" });
  } catch (error) {
    results.push({ n: i + 1, status: "THREW", error: String(error).slice(0, 160) });
  }
}
console.log("@@ATTACKS@@" + JSON.stringify(results));
process.exit(0);
`;

export const HARNESS_FILE = "scripts/__attacks.ts";

export interface AttackReport {
  held: Set<number>;
  broke: Set<number>;
  threw: Map<number, string>;
  total: number;
}

export function parseAttacks(out: string): AttackReport | null {
  const line = out.split("\n").find((l) => l.startsWith("@@ATTACKS@@"));
  if (!line) return null;
  const rows = JSON.parse(line.slice("@@ATTACKS@@".length)) as Array<{ n: number; status: string; error?: string }>;
  const report: AttackReport = { held: new Set(), broke: new Set(), threw: new Map(), total: rows.length };
  for (const r of rows) {
    if (r.status === "HELD") report.held.add(r.n);
    else if (r.status === "BROKE") report.broke.add(r.n);
    else report.threw.set(r.n, r.error ?? "threw");
  }
  return report;
}

export async function runAttacks(ws: string, timeoutMs: number): Promise<AttackReport | null> {
  writeFileSync(join(ws, HARNESS_FILE), ATTACK_HARNESS);
  return parseAttacks((await run(["bun", "run", HARNESS_FILE], ws, timeoutMs)).out);
}

// ---- the private copy ---------------------------------------------------------------------------------------------

/** What a mutated copy needs to run the red team and the test files the catalog names. */
export const COPY = ["src", "tests", "scripts", "fixtures", "web/lib", "package.json", "tsconfig.json", "bun.lock"];

/** Copies the repo into a fresh temp directory and links node_modules. The directory is never inside `root`. */
export function prepareWorkspace(root: string, paths: string[] = COPY): string {
  const real = resolve(root);
  const ws = mkdtempSync(join(tmpdir(), "tessera-mutate-"));
  if (resolve(ws) === real || resolve(ws).startsWith(real + sep)) throw new Error(`refusing to use a workspace inside the repo: ${ws}`);
  for (const path of paths) {
    if (existsSync(join(real, path))) cpSync(join(real, path), join(ws, path), { recursive: true });
  }
  if (existsSync(join(real, "node_modules"))) symlinkSync(join(real, "node_modules"), join(ws, "node_modules"), "dir");
  return ws;
}

export function removeWorkspace(ws: string): void {
  // The symlink is removed as a link, never followed: rmSync does not recurse into a symlinked directory.
  rmSync(ws, { recursive: true, force: true });
}

// ---- one mutation, end to end -------------------------------------------------------------------------------------

export interface Options {
  attacks: boolean;
  typecheck: boolean;
  timeoutMs: number;
}

export interface Outcome {
  id: string;
  /** INVALID: the mutation breaks the build or the red team harness, so it proves nothing. */
  verdict: Verdict | "INVALID";
  caught: string[];
  missed: string[];
  /** Attacks that broke although the catalog did not expect them: informational. */
  unexpected: number[];
  threw: Array<[number, string]>;
  note: string | null;
  ms: number;
}

export async function evaluate(ws: string, mutation: Mutation, originals: Map<string, string>, mutated: Map<string, string>, opts: Options): Promise<Outcome> {
  const started = Date.now();
  const outcome = (o: Omit<Outcome, "id" | "ms">): Outcome => ({ id: mutation.id, ms: Date.now() - started, ...o });
  try {
    for (const [file, content] of mutated) writeFileSync(join(ws, file), content);

    if (opts.typecheck) {
      const tc = await run(["bun", "run", "typecheck"], ws, opts.timeoutMs);
      if (tc.code !== 0) {
        const first = tc.out.split("\n").find((l) => l.includes("error TS")) ?? "does not typecheck";
        return outcome({ verdict: "INVALID", caught: [], missed: [], unexpected: [], threw: [], note: `the mutated copy does not compile: ${first.trim()}` });
      }
    }

    let report: AttackReport | null = null;
    if (opts.attacks) {
      report = await runAttacks(ws, opts.timeoutMs);
      if (!report) return outcome({ verdict: "INVALID", caught: [], missed: [], unexpected: [], threw: [], note: "the red team could not load under this mutation (build broken), so it proves nothing" });
    }

    const testsFailed: boolean[] = [];
    for (const t of mutation.expect.tests ?? []) testsFailed.push((await runTests(ws, t, opts.timeoutMs)).failed);

    const broke = report?.broke ?? new Set<number>();
    const threw = new Set(report?.threw.keys() ?? []);
    const { verdict, caught, missed } = classify(mutation.expect, { broke, threw, testsFailed });
    const expectedAttacks = new Set(mutation.expect.attacks ?? []);
    return outcome({
      verdict,
      caught,
      missed,
      unexpected: [...broke].filter((n) => !expectedAttacks.has(n)),
      threw: [...(report?.threw ?? [])].filter(([n]) => expectedAttacks.has(n)),
      note: null,
    });
  } finally {
    for (const file of mutated.keys()) writeFileSync(join(ws, file), originals.get(file)!);
  }
}

export const readReal = (root: string) => (file: string): string => readFileSync(join(root, file), "utf8");
