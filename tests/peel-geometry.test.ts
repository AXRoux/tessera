import { describe, expect, it } from "bun:test";
import {
  area,
  clampTip,
  clearance,
  cssPolygon,
  cut,
  foldFor,
  hull,
  rect,
  reflect,
  reflectionMatrix,
  releasePeels,
  side,
  teaseLift,
  unit,
  vec,
} from "../web/lib/peel-geometry";

const W = 1600;
const H = 900;
const corner = vec(W, H);
const page = rect(0, 0, W, H);
const close = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  expect(a.x).toBeCloseTo(b.x, 6);
  expect(a.y).toBeCloseTo(b.y, 6);
};

describe("peeling a corner", () => {
  it("folds along the perpendicular bisector: the corner lands exactly where it was lifted to", () => {
    const tip = vec(W - 120, H - 80);
    const fold = foldFor(corner, tip)!;
    close(reflect(corner, fold), tip);
    expect(side(corner, fold)).toBeGreaterThan(0);
    expect(side(tip, fold)).toBeLessThan(0);
    expect(foldFor(corner, corner)).toBeNull();
  });

  it("cuts a dog-ear into a triangle whose legs are as long as the lift along each axis", () => {
    const fold = foldFor(corner, vec(W - 40, H - 40))!;
    const lifted = cut(page, fold, "lifted");
    expect(lifted).toHaveLength(3);
    expect(area(lifted)).toBeCloseTo((40 * 40) / 2, 3);
    // What stays stuck down and what came off add back up to the page.
    expect(area(cut(page, fold, "flat")) + area(lifted)).toBeCloseTo(W * H, 3);
  });

  it("folds the lifted material over as its mirror image, the same size", () => {
    const fold = foldFor(corner, vec(W - 300, H - 140))!;
    const lifted = cut(page, fold, "lifted");
    const flap = lifted.map((p) => reflect(p, fold));
    expect(area(flap)).toBeCloseTo(area(lifted), 3);
    for (const p of flap) expect(side(p, fold)).toBeLessThanOrEqual(1e-9);
  });

  it("draws a texture folded over with the same reflection as the geometry", () => {
    const fold = foldFor(corner, vec(W - 210, H - 333))!;
    const [a, b, c, d, e, f] = reflectionMatrix(fold);
    for (const p of [vec(W, H), vec(W - 50, H - 10), vec(1234, 567)]) {
      close({ x: a * p.x + c * p.y + e, y: b * p.x + d * p.y + f }, reflect(p, fold));
    }
  });

  it("knows how far to travel for the whole sheet to come off", () => {
    const direction = unit(vec(-W, -H));
    const t = clearance(corner, direction, page);
    const fold = foldFor(corner, vec(W + direction.x * (t + 1), H + direction.y * (t + 1)))!;
    expect(cut(page, fold, "flat")).toEqual([]);
    expect(area(cut(page, fold, "lifted"))).toBeCloseTo(W * H, 3);
  });

  it("outlines the grab area as one convex shape around the corner and its flap", () => {
    const fold = foldFor(corner, vec(W - 90, H - 90))!;
    const lifted = cut(page, fold, "lifted");
    const outline = hull([...lifted, ...lifted.map((p) => reflect(p, fold))]);
    expect(outline).toHaveLength(4); // a kite: the corner, the two ends of the fold, the lifted tip
    expect(area(outline)).toBeCloseTo(90 * 90, 3);
  });

  it("writes a clip-path in the element's own coordinates, and clips everything for an empty shape", () => {
    expect(cssPolygon([vec(10, 20), vec(30, 20), vec(30, 40)], vec(10, 0))).toBe("polygon(0.0px 20.0px, 20.0px 20.0px, 20.0px 40.0px)");
    expect(cssPolygon([])).toBe("polygon(0 0, 0 0, 0 0)");
  });
});

describe("how the corner answers the hand", () => {
  const options = { zone: 300, rest: 40, reach: 240 };

  it("rests as a small dog-ear folded at 45° when nobody is near", () => {
    const lift = teaseLift(corner, null, options);
    expect(Math.hypot(lift.x, lift.y)).toBeCloseTo(40, 6);
    expect(lift.x).toBeCloseTo(lift.y, 9);
    expect(teaseLift(corner, vec(200, 200), options)).toEqual(lift);
  });

  it("lifts toward a pointer that comes close, more the closer it is, never past it", () => {
    const far = teaseLift(corner, vec(W - 200, H - 150), options);
    const near = teaseLift(corner, vec(W - 90, H - 70), options);
    expect(Math.hypot(near.x, near.y)).toBeGreaterThan(Math.hypot(far.x, far.y));
    const touching = teaseLift(corner, vec(W - 12, H - 12), options);
    expect(Math.hypot(touching.x, touching.y)).toBeCloseTo(40, 6); // already at the corner: just the dog-ear
    for (const lift of [far, near]) {
      expect(lift.x).toBeLessThan(0);
      expect(lift.y).toBeLessThan(0);
    }
  });

  it("keeps a dragged corner on the page and pointing inward", () => {
    close(clampTip(corner, vec(W + 50, H + 50), W, H, 40), vec(W - 40 / Math.SQRT2, H - 40 / Math.SQRT2));
    expect(clampTip(corner, vec(-5000, -5000), W, H, 40)).toEqual(vec(-W * 0.6, -H * 0.6));
  });

  it("peels away on a click, a long pull or a flick, and settles back on a short drag", () => {
    expect(releasePeels(vec(-40, -40), 2, vec(0, 0), W, H)).toBe(true);
    expect(releasePeels(vec(-400, -260), 300, vec(0, 0), W, H)).toBe(true);
    expect(releasePeels(vec(-120, -80), 80, vec(-1.4, -0.9), W, H)).toBe(true);
    expect(releasePeels(vec(-120, -80), 80, vec(0, 0), W, H)).toBe(false);
  });
});
