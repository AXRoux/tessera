/**
 * `bun run redteam`: runs every attack in tests/redteam/attacks.ts and prints a scoreboard. Offline and deterministic:
 * it needs no keys, because the invariants live in code, not in a model or in Airwallex.
 */
import { ATTACKS } from "../tests/redteam/attacks";

const compact = process.argv.includes("--compact");
const tty = Boolean(process.stdout.isTTY || process.env.FORCE_COLOR);
const paint = (code: string, text: string) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
const green = (t: string) => paint("32", t);
const red = (t: string) => paint("31", t);
const dim = (t: string) => paint("2", t);
const bold = (t: string) => paint("1", t);

console.log(bold("\nTESSERA RED TEAM") + dim("  every move below tries to pay twice, pay the wrong party, or rewrite history\n"));

let held = 0;
for (const [index, attack] of ATTACKS.entries()) {
  const result = await attack.run();
  if (result.held) held++;
  const mark = result.held ? green("HELD  ") : red("BROKE ");
  const heading = `${mark} ${String(index + 1).padStart(2, "0")}  ${bold(attack.title)}  ${dim(`[${attack.layer}]`)}`;
  if (compact) {
    console.log(`${heading}\n            ${dim(result.held ? "stopped by" : "NOT stopped:")} ${result.stoppedBy.replace("; with the policy bypassed, ", "  ·  policy bypassed: ")}`);
    continue;
  }
  console.log(heading);
  console.log(dim(`            ${attack.trick}`));
  console.log(`            ${result.held ? "stopped by" : "NOT stopped:"} ${result.stoppedBy}  ${dim("-> " + result.observed)}\n`);
}

const all = held === ATTACKS.length;
console.log(`${compact ? "\n" : ""}${all ? green("PASS") : red("FAIL")}  ${held}/${ATTACKS.length} attacks held\n`);
process.exit(all ? 0 : 1);
