/**
 * Peeling a page from one corner, like a sticker. Pure geometry, no DOM, so the moves can be tested.
 *
 * Lift the corner C to a point P and the sheet folds along the perpendicular bisector of CP. Everything on C's side of
 * that line has come off (what lies underneath shows through), and the same material, folded over, lies on the other
 * side as its mirror image, back side up. That is the whole model: one line, one cut, one reflection.
 */

export interface Vec {
  x: number;
  y: number;
}

export interface Fold {
  /** A point on the fold line: the midpoint of the corner and where it has been lifted to. */
  m: Vec;
  /** Unit normal of the fold line, pointing toward the corner (the lifted side). */
  n: Vec;
}

export const vec = (x: number, y: number): Vec => ({ x, y });
export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
export const length = (a: Vec): number => Math.hypot(a.x, a.y);
export const lerp = (a: Vec, b: Vec, t: number): Vec => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const unit = (a: Vec): Vec => {
  const d = length(a);
  return d < 1e-9 ? { x: 0, y: 0 } : { x: a.x / d, y: a.y / d };
};

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
/** 0 at `from`, 1 at `to`, eased, either direction. */
export function smoothstep(from: number, to: number, v: number): number {
  const t = clamp((v - from) / (to - from), 0, 1);
  return t * t * (3 - 2 * t);
}

/** An axis-aligned rectangle as a clockwise polygon (screen coordinates, y down). */
export function rect(x: number, y: number, w: number, h: number): Vec[] {
  return [vec(x, y), vec(x + w, y), vec(x + w, y + h), vec(x, y + h)];
}

/** The fold for a corner lifted to `tip`, or null while the corner has not moved. */
export function foldFor(corner: Vec, tip: Vec): Fold | null {
  const toCorner = sub(corner, tip);
  const d = length(toCorner);
  if (d < 1e-3) return null;
  return { m: lerp(corner, tip, 0.5), n: scale(toCorner, 1 / d) };
}

/** Signed distance from the fold line: positive on the lifted (corner) side. */
export const side = (p: Vec, fold: Fold): number => dot(sub(p, fold.m), fold.n);

/** Where a point of the lifted material lies once folded over: its mirror image in the fold line. */
export const reflect = (p: Vec, fold: Fold): Vec => sub(p, scale(fold.n, 2 * side(p, fold)));

/**
 * The reflection as a 2D affine matrix [a, b, c, d, e, f] (the order canvas `setTransform` takes), so a whole texture
 * can be drawn folded over in one call: x' = a·x + c·y + e, y' = b·x + d·y + f.
 */
export function reflectionMatrix(fold: Fold): [number, number, number, number, number, number] {
  const { n } = fold;
  const k = 2 * dot(fold.m, n);
  return [1 - 2 * n.x * n.x, -2 * n.x * n.y, -2 * n.x * n.y, 1 - 2 * n.y * n.y, k * n.x, k * n.y];
}

/**
 * The part of a convex polygon on one side of the fold: "lifted" (off the page) or "flat" (still stuck down).
 * Sutherland–Hodgman against a single line; points within half a pixel of each other are merged.
 */
export function cut(polygon: Vec[], fold: Fold, keep: "lifted" | "flat"): Vec[] {
  const sign = keep === "lifted" ? 1 : -1;
  const out: Vec[] = [];
  const push = (p: Vec) => {
    const last = out[out.length - 1];
    if (!last || Math.abs(last.x - p.x) > 0.5 || Math.abs(last.y - p.y) > 0.5) out.push(p);
  };
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    const da = side(a, fold) * sign;
    const db = side(b, fold) * sign;
    if (da >= 0) push(a);
    if (da >= 0 !== db >= 0) push(lerp(a, b, da / (da - db)));
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (out.length > 1 && first && last && Math.abs(first.x - last.x) <= 0.5 && Math.abs(first.y - last.y) <= 0.5) out.pop();
  return out.length >= 3 ? out : [];
}

/** Twice the signed area; its absolute value halved is the area. */
export function area(polygon: Vec[]): number {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** The convex hull (Andrew's monotone chain): the outline the hand can grab, the peeled corner and its flap together. */
export function hull(points: Vec[]): Vec[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (sorted.length < 3) return sorted;
  const cross = (o: Vec, a: Vec, b: Vec) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec[] = [];
  for (const p of sorted.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/**
 * How far along `direction` (a unit vector from the corner into the page) the corner must travel for the whole of
 * `polygon` to be on the lifted side: the sheet is then entirely off, and its flap entirely past the far edge.
 */
export function clearance(corner: Vec, direction: Vec, polygon: Vec[]): number {
  return 2 * Math.max(...polygon.map((p) => dot(sub(p, corner), direction)));
}

/** A CSS `polygon()` for clip-path, shifted into an element's own coordinates. Empty polygons clip everything away. */
export function cssPolygon(polygon: Vec[], origin: Vec = vec(0, 0)): string {
  if (polygon.length < 3) return "polygon(0 0, 0 0, 0 0)";
  return `polygon(${polygon.map((p) => `${(p.x - origin.x).toFixed(1)}px ${(p.y - origin.y).toFixed(1)}px`).join(", ")})`;
}

/* ── How the corner answers the hand ───────────────────────────────────────────────────────────────────────────── */

export interface TeaseOptions {
  /** How far (px) from the corner the pointer starts to lift it. */
  zone: number;
  /** The dog-ear at rest: how far (px) the corner is lifted along the diagonal when nobody is near. */
  rest: number;
  /** The most (px) a hovering pointer lifts the corner. */
  reach: number;
}

/** The way a bottom-right corner lifts at rest: a dog-ear folded at 45°. */
export const restDirection = (): Vec => unit(vec(-1, -1));

/**
 * Where the corner wants to be, as an offset from where it is stuck down, given the pointer (or none). At rest it is a
 * small dog-ear along the diagonal; as the pointer comes within `zone` it lifts toward it, never past it.
 */
export function teaseLift(corner: Vec, pointer: Vec | null, options: TeaseOptions): Vec {
  const diagonal = restDirection();
  const rest = scale(diagonal, options.rest);
  if (!pointer) return rest;
  const toPointer = sub(pointer, corner);
  const distance = length(toPointer);
  const pull = smoothstep(options.zone, options.zone * 0.25, distance);
  if (pull <= 0) return rest;
  // Point the fold at the pointer, but only partly: a corner that swung all the way round would look broken.
  const direction = unit(lerp(diagonal, unit(toPointer), 0.75 * pull));
  const reach = Math.min(options.rest + (options.reach - options.rest) * pull, Math.max(options.rest, distance * 0.95));
  return scale(direction, reach);
}

/** Keep a dragged corner on the page and pointing inward, so the fold never turns inside out. */
export function clampTip(corner: Vec, tip: Vec, width: number, height: number, minimum: number): Vec {
  const x = clamp(tip.x, -width * 0.6, corner.x);
  const y = clamp(tip.y, -height * 0.6, corner.y);
  const lift = sub(vec(x, y), corner);
  if (length(lift) >= minimum) return vec(x, y);
  return add(corner, scale(restDirection(), minimum));
}

/**
 * Whether letting go of a dragged corner peels the page away or lets it settle back: far enough, or flicked inward.
 * A press that barely moved is a click, and a click on the corner peels it too.
 */
export function releasePeels(lift: Vec, travelled: number, velocity: Vec, width: number, height: number): boolean {
  if (travelled < 6) return true;
  const inward = dot(velocity, restDirection());
  return length(lift) > Math.min(width, height) * 0.3 || inward > 0.9;
}
