import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyEdit, applyEdits, classify, evaluate, parseAttacks, prepareWorkspace, removeWorkspace, StaleMutation, type Mutation } from "../scripts/mutate-lib";

/**
 * The mechanics of `bun run mutate`, on a tiny fixture project. The real catalog (49 mutations against the real source)
 * is too slow for the unit suite: `bun run mutate` runs it.
 */
const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "mutate-fixture-"));
  made.push(root);
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "tests"));
  writeFileSync(join(root, "src/guard.ts"), "export const allowed = (n: number): boolean => n < 10;\n");
  writeFileSync(
    join(root, "tests/guard.test.ts"),
    `import { expect, it } from "bun:test";\nimport { allowed } from "../src/guard";\nit("refuses 20", () => expect(allowed(20)).toBe(false));\nit("allows 3", () => expect(allowed(3)).toBe(true));\n`,
  );
  return root;
}

const OPTIONS = { attacks: false, typecheck: false, timeoutMs: 60_000 };
const mutation = (find: string, replace: string): Mutation => ({
  id: "m",
  describe: "d",
  edits: [{ file: "src/guard.ts", find, replace }],
  expect: { tests: [{ file: "tests/guard.test.ts" }] },
});

describe("applying an edit", () => {
  it("replaces an anchor that occurs exactly once", () => {
    expect(applyEdit("a < 10; b", { file: "f", find: "< 10", replace: "< 99" }, "m")).toBe("a < 99; b");
  });

  it("refuses an anchor that is gone, and one that is ambiguous, naming the file", () => {
    expect(() => applyEdit("nothing here", { file: "src/x.ts", find: "< 10", replace: "< 99" }, "m")).toThrow(StaleMutation);
    expect(() => applyEdit("a < 10; b < 10", { file: "src/x.ts", find: "< 10", replace: "< 99" }, "m")).toThrow(/src\/x\.ts.*2 time/);
  });

  it("refuses an edit that changes nothing, because it would prove nothing", () => {
    expect(() => applyEdit("a", { file: "f", find: "a", replace: "a" }, "m")).toThrow(StaleMutation);
  });

  it("applies several edits to one file in order, and to different files separately", () => {
    const files: Record<string, string> = { "a.ts": "one two", "b.ts": "three" };
    const out = applyEdits((f) => files[f]!, [
      { file: "a.ts", find: "one", replace: "1" },
      { file: "a.ts", find: "two", replace: "2" },
      { file: "b.ts", find: "three", replace: "3" },
    ], "m");

    expect(out.get("a.ts")).toBe("1 2");
    expect(out.get("b.ts")).toBe("3");
  });
});

describe("judging a mutation", () => {
  const expectTwo = { attacks: [5], tests: [{ file: "t" }] };

  it("is KILLED only when everything expected to notice did", () => {
    expect(classify(expectTwo, { broke: new Set([5]), threw: new Set(), testsFailed: [true] }).verdict).toBe("KILLED");
  });

  it("is PARTIAL when only some did, and says which did not", () => {
    const r = classify(expectTwo, { broke: new Set(), threw: new Set(), testsFailed: [true] });

    expect(r.verdict).toBe("PARTIAL");
    expect(r.missed).toEqual(["attack 5"]);
  });

  it("is SURVIVED when nothing noticed", () => {
    expect(classify(expectTwo, { broke: new Set(), threw: new Set(), testsFailed: [false] }).verdict).toBe("SURVIVED");
  });

  it("counts an attack that threw as not holding", () => {
    expect(classify({ attacks: [5] }, { broke: new Set(), threw: new Set([5]), testsFailed: [] }).verdict).toBe("KILLED");
  });

  it("reads the red team harness line and ignores everything else on stdout", () => {
    const out = `noise\n@@ATTACKS@@${JSON.stringify([{ n: 1, status: "HELD" }, { n: 2, status: "BROKE" }, { n: 3, status: "THREW", error: "boom" }])}\nmore`;
    const report = parseAttacks(out)!;

    expect([...report.held, ...report.broke, ...report.threw.keys()]).toEqual([1, 2, 3]);
    expect(parseAttacks("the build crashed before printing anything")).toBeNull();
  });
});

describe("running one mutation in a private copy", () => {
  it("kills a mutation a test notices, and leaves the copy exactly as it found it", async () => {
    const root = fixture();
    const ws = prepareWorkspace(root, ["src", "tests"]);
    const original = readFileSync(join(ws, "src/guard.ts"), "utf8");
    const m = mutation("n < 10", "true");

    const outcome = await evaluate(ws, m, new Map([["src/guard.ts", original]]), applyEdits((f) => readFileSync(join(root, f), "utf8"), m.edits, m.id), OPTIONS);

    expect(outcome.verdict).toBe("KILLED");
    expect(readFileSync(join(ws, "src/guard.ts"), "utf8")).toBe(original);
    expect(readFileSync(join(root, "src/guard.ts"), "utf8")).toBe(original);
    removeWorkspace(ws);
  });

  it("reports SURVIVED for a mutation that changes nothing observable", async () => {
    const root = fixture();
    const ws = prepareWorkspace(root, ["src", "tests"]);
    const original = readFileSync(join(ws, "src/guard.ts"), "utf8");
    const m = mutation("n < 10", "10 > n"); // the same behaviour written the other way round

    const outcome = await evaluate(ws, m, new Map([["src/guard.ts", original]]), applyEdits((f) => readFileSync(join(root, f), "utf8"), m.edits, m.id), OPTIONS);

    expect(outcome.verdict).toBe("SURVIVED");
    removeWorkspace(ws);
  });
});

describe("never touching the real working tree", () => {
  const repo = resolve(import.meta.dir, "..");
  const fingerprint = () => {
    const hasher = new Bun.CryptoHasher("sha256");
    for (const file of [...new Bun.Glob("src/**/*.ts").scanSync({ cwd: repo })].toSorted()) hasher.update(readFileSync(join(repo, file)));
    return hasher.digest("hex");
  };

  it("mutates a copy outside the repo and leaves every file under src/ byte-identical", () => {
    const before = fingerprint();
    const ws = prepareWorkspace(repo);

    expect(ws.startsWith(repo)).toBe(false);
    const target = join(ws, "src/gateway/gateway.ts");
    writeFileSync(target, `${readFileSync(target, "utf8")}\n// mutated\n`);

    expect(readFileSync(join(repo, "src/gateway/gateway.ts"), "utf8")).not.toContain("// mutated");
    expect(fingerprint()).toBe(before);
    removeWorkspace(ws);
  });
});
