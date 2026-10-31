import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PROXIED_ROUTE } from "../web/lib/proxy-routes";

/**
 * The console reaches the API only through a same-origin proxy that answers 404 to any route it does not list. A button
 * whose route is missing from that list looks fine in the code and fails when pressed ("Reset demo" did exactly that),
 * so this reads every call the console makes and checks the proxy lets it through.
 */
const web = resolve(import.meta.dir, "..", "web");
const sources = [...new Bun.Glob("{components,lib,app}/**/*.{ts,tsx}").scanSync({ cwd: web })].filter((f) => !f.startsWith("app/api/") && !f.endsWith("proxy-routes.ts"));

/** Every path the console passes to `api("...")` or fetches under `/api/`, with template holes filled in as `x`. */
function consoleRoutes(): Array<{ file: string; route: string }> {
  const found: Array<{ file: string; route: string }> = [];
  for (const file of sources) {
    const text = readFileSync(join(web, file), "utf8");
    for (const m of text.matchAll(/\bapi\(\s*(["`])([^"`]+)\1/g)) found.push({ file, route: m[2]!.replace(/\$\{[^}]*\}/g, "x") });
    for (const m of text.matchAll(/fetch\(\s*(["`])\/api\/([^"`]+)\1/g)) found.push({ file, route: m[2]!.replace(/\$\{[^}]*\}/g, "x") });
  }
  // A path that is nothing but a template hole is `client-api.ts` building `/api/${path}` for its callers: the helper, not a route.
  return found.filter(({ route }) => route !== "x");
}

describe("the console's same-origin proxy", () => {
  it("lets through every API route the console calls", () => {
    const routes = consoleRoutes();

    expect(routes.length).toBeGreaterThan(10); // the scan itself works: it found the console's calls
    const refused = routes.filter(({ route }) => !PROXIED_ROUTE.test(route));
    expect(refused).toEqual([]);
  });

  it("does not let the browser reach routes that must not carry the operator token", () => {
    expect(PROXIED_ROUTE.test("webhooks/airwallex")).toBe(false);
    expect(PROXIED_ROUTE.test("../obligations")).toBe(false);
    expect(PROXIED_ROUTE.test("obligations/x/../../health")).toBe(false);
    expect(PROXIED_ROUTE.test("demo")).toBe(false);
  });
});
