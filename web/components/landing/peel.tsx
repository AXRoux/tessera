"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  add,
  area,
  clamp,
  clampTip,
  clearance,
  cssPolygon,
  cut,
  dot,
  foldFor,
  hull,
  length,
  lerp,
  rect,
  reflect,
  reflectionMatrix,
  releasePeels,
  restDirection,
  scale,
  side,
  sub,
  teaseLift,
  unit,
  vec,
  type Fold,
  type Vec,
} from "@/lib/peel-geometry";

/*
 * The page as a sticker. Its bottom-right corner is a dog-ear; bring the pointer near and it lifts toward you, drag it
 * and it follows your hand, let go far enough (or click it, or press a sign-in button) and the whole sheet peels away
 * to what was underneath.
 *
 * It works in every browser, Safari first. Effects like this one usually photograph the live page into a WebGL texture,
 * which needs Chrome's experimental HTML-in-Canvas; here nothing is photographed. The page stays live DOM and is cut
 * along the fold with a CSS clip-path, and only the paper itself is painted on a 2D canvas: the back of the sticker
 * folded over (a pearl security foil, microprinted), the light along the crease and the shadows it throws. The geometry
 * is one line, one cut and one reflection (`lib/peel-geometry.ts`).
 */

interface PeelControls {
  /** Someone is reaching for what is underneath (hovering a sign-in button): mount it now so it is ready. */
  prime: () => void;
  /** A sign-in button is under the pointer or the keyboard: lift the corner a little, so it shows where it leads. */
  beckon: (on: boolean) => void;
}

const PeelContext = createContext<PeelControls>({ prime: () => {}, beckon: () => {} });
export const usePeel = (): PeelControls => useContext(PeelContext);

type Mode = "rest" | "drag" | "opening" | "open" | "closing";

interface Tween {
  from: Vec;
  to: Vec;
  start: number;
  duration: number;
}

interface Palette {
  base: [string, string, string];
  sheen: [string, string, string];
  ink: string;
  edge: string;
  specular: number;
  cast: string;
  contact: number;
}

const PALETTE: Record<"light" | "dark", Palette> = {
  light: {
    base: ["#fdfdfe", "#eceef3", "#f7f8fa"],
    sheen: ["rgb(29 104 255 / 0.10)", "rgb(150 120 255 / 0.07)", "rgb(70 210 200 / 0.06)"],
    ink: "rgb(13 15 20 / 0.075)",
    edge: "rgb(13 15 20 / 0.10)",
    specular: 0.75,
    cast: "rgb(22 30 52 / 0.30)",
    contact: 0.24,
  },
  dark: {
    base: ["#2b2e35", "#16181c", "#23262c"],
    sheen: ["rgb(43 116 255 / 0.16)", "rgb(150 110 255 / 0.09)", "rgb(70 200 190 / 0.07)"],
    ink: "rgb(243 244 246 / 0.085)",
    edge: "rgb(255 255 255 / 0.10)",
    specular: 0.34,
    cast: "rgb(0 0 0 / 0.62)",
    contact: 0.5,
  },
};

const MICROPRINT = "TESSERA · SEALED · VOID IF LIFTED · ";

/** One tile of the foil's microprint, mirrored: it is printed on the back, so it reads true once the sheet folds over. */
function microprintTile(ink: string, family: string, density: number): HTMLCanvasElement {
  const probe = document.createElement("canvas").getContext("2d")!;
  probe.font = `500 9px ${family}`;
  const width = Math.ceil(probe.measureText(MICROPRINT).width);
  const line = 13;
  const tile = document.createElement("canvas");
  tile.width = Math.max(1, Math.round(width * density));
  tile.height = Math.round(line * 2 * density);
  const ctx = tile.getContext("2d")!;
  ctx.scale(density, density);
  ctx.translate(width, 0);
  ctx.scale(-1, 1);
  ctx.font = `500 9px ${family}`;
  ctx.fillStyle = ink;
  ctx.textBaseline = "middle";
  ctx.fillText(MICROPRINT, 0, line * 0.5);
  ctx.fillText(MICROPRINT, -width / 2, line * 1.5);
  ctx.fillText(MICROPRINT, width / 2, line * 1.5);
  return tile;
}

export interface PeelPageProps {
  /** The page that peels away. */
  children: ReactNode;
  /** What lies underneath. Mounted the first time someone reaches for it, so the landing pays nothing until then. */
  under: ReactNode;
  /** A word or two printed under the corner, read as it lifts. */
  hint: ReactNode;
  /** Whether the sheet is off. The page's URL decides this, so Back puts the sticker back down. */
  open: boolean;
  /** Someone peeled the sheet away by hand (a long pull, a flick, a click on the corner). */
  onPeeled: () => void;
  /** The corner's accessible name: what peeling it does. */
  label: string;
}

export function PeelPage({ children, under, hint, open, onPeeled, label }: PeelPageProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const underRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gripRef = useRef<HTMLButtonElement>(null);
  const engine = useRef<{ setOpen: (open: boolean) => void; wake: () => void } | null>(null);
  const beckoning = useRef(false);
  const openRef = useRef(open);
  const peeledRef = useRef(onPeeled);
  const [primed, setPrimed] = useState(open);
  const [settled, setSettled] = useState(false);

  const prime = useCallback(() => setPrimed(true), []);
  const beckon = useCallback((on: boolean) => {
    if (on) setPrimed(true);
    beckoning.current = on;
    engine.current?.wake();
  }, []);

  useEffect(() => {
    peeledRef.current = onPeeled;
  }, [onPeeled]);

  useEffect(() => {
    openRef.current = open;
    if (open) setPrimed(true);
    engine.current?.setOpen(open);
  }, [open]);

  useEffect(() => {
    const sheet = sheetRef.current;
    const canvas = canvasRef.current;
    const grip = gripRef.current;
    const underEl = underRef.current;
    if (!sheet || !canvas || !grip || !underEl) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const ctx = context;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const coarse = window.matchMedia("(pointer: coarse)");
    const themeRoot = sheet.closest<HTMLElement>("[data-theme]") ?? document.documentElement;

    let W = window.innerWidth;
    let H = window.innerHeight;
    let dpr = 1;
    let box = sheet.getBoundingClientRect();
    let palette = PALETTE.light;
    let pattern: CanvasPattern | null = null;
    let patternDensity = 1;

    const corner = () => vec(W, H);
    const restSize = () => (coarse.matches ? 64 : 52);
    const tease = () => ({ zone: clamp(Math.min(W, H) * 0.34, 200, 340), rest: restSize(), reach: clamp(Math.min(W, H) * 0.27, 150, 260) });

    let mode: Mode = openRef.current ? "open" : "rest";
    let lift: Vec = scale(restDirection(), restSize());
    let goal: Vec = lift;
    let tween: Tween | null = null;
    let pointer: Vec | null = null;
    let drag: { id: number; start: Vec; offset: Vec; travelled: number; last: Vec; at: number; velocity: Vec } | null = null;
    let suppressClick = false;
    let peek: { start: number } | null = null;
    let raf = 0;
    let last = performance.now();

    /* ── Sizing, palette, the foil ── */

    /** Pixel density of the paper: full while it is a corner in the hand, lighter while a whole sheet sweeps past. */
    const fullDensity = () => Math.min(window.devicePixelRatio || 1, 2);
    const sweepDensity = () => Math.min(fullDensity(), 1.5);
    function density(next: number) {
      if (next === dpr && canvas!.width === Math.round(W * next)) return;
      dpr = next;
      canvas!.width = Math.round(W * dpr);
      canvas!.height = Math.round(H * dpr);
    }

    function measure() {
      W = window.innerWidth;
      H = window.innerHeight;
      density(mode === "opening" || mode === "closing" ? sweepDensity() : fullDensity());
      box = sheet!.getBoundingClientRect();
    }

    function paint() {
      palette = PALETTE[themeRoot.getAttribute("data-theme") === "dark" ? "dark" : "light"];
      const family = getComputedStyle(document.body).getPropertyValue("--font-plex-mono").trim() || "ui-monospace, monospace";
      patternDensity = fullDensity();
      pattern = ctx.createPattern(microprintTile(palette.ink, `${family}, ui-monospace, monospace`, patternDensity), "repeat");
    }

    /* ── Drawing one frame ── */

    function trace(points: Vec[]) {
      ctx.beginPath();
      points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
    }

    /** The back of the sticker, drawn in the sheet's own coordinates and folded over with the same reflection as the geometry. */
    function drawBacking(fold: Fold, lifted: Vec[]) {
      const [a, b, c, d, e, f] = reflectionMatrix(fold);
      ctx.save();
      ctx.setTransform(a * dpr, b * dpr, c * dpr, d * dpr, e * dpr, f * dpr);
      trace(lifted);
      ctx.clip();
      const base = ctx.createLinearGradient(W, H, W - 1100, H - 700);
      base.addColorStop(0, palette.base[0]);
      base.addColorStop(0.55, palette.base[1]);
      base.addColorStop(1, palette.base[2]);
      ctx.fillStyle = base;
      ctx.fillRect(-W, -H, W * 3, H * 3);
      // A faint holographic sheen, fixed to the material so it slides as the sheet turns.
      const sheen = ctx.createLinearGradient(W - 40, H - 900, W - 900, H + 60);
      const [blue, violet, mint] = palette.sheen;
      for (let i = 0; i <= 6; i++) sheen.addColorStop(i / 6, [blue, "transparent", violet, "transparent", mint, "transparent", blue][i]!);
      ctx.fillStyle = sheen;
      ctx.fillRect(-W, -H, W * 3, H * 3);
      if (pattern) {
        ctx.translate(W, H);
        ctx.rotate(-0.42);
        ctx.scale(1 / patternDensity, 1 / patternDensity);
        ctx.fillStyle = pattern;
        const span = (W + H) * 2 * patternDensity;
        ctx.fillRect(-span, -span, span * 2, span * 2);
      }
      ctx.restore();
    }

    function draw() {
      // The page underneath knows the moment: its hint fades as soon as the sheet starts to come off.
      if (underEl!.dataset.peel !== mode) underEl!.dataset.peel = mode;
      const C = corner();
      const tip = add(C, lift);
      const fold = foldFor(C, tip);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas!.width, canvas!.height);

      if (mode === "open" || !fold) {
        const sheetClip = mode === "open" ? cssPolygon([]) : "none";
        sheet!.style.clipPath = sheetClip;
        sheet!.style.setProperty("-webkit-clip-path", sheetClip);
        grip!.style.visibility = "hidden";
        return;
      }

      // The sheet: everything still stuck down, in its own coordinates (it may be taller than the window and scrolled).
      const flat = cut(rect(box.left, box.top, box.width, box.height), fold, "flat");
      const sheetClip = cssPolygon(flat, vec(box.left, box.top));
      sheet!.style.clipPath = sheetClip;
      sheet!.style.setProperty("-webkit-clip-path", sheetClip);

      const lifted = cut(rect(0, 0, W, H), fold, "lifted");
      if (lifted.length < 3) {
        grip!.style.visibility = "hidden";
        return;
      }
      const flap = lifted.map((p) => reflect(p, fold));

      // What a hand can take hold of: the lifted corner and its flap.
      const outline = hull([...lifted, ...flap]);
      grip!.style.visibility = mode === "rest" || mode === "drag" ? "visible" : "hidden";
      const gripClip = cssPolygon(outline);
      grip!.style.clipPath = gripClip;
      grip!.style.setProperty("-webkit-clip-path", gripClip);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const amount = length(lift);
      const radius = clamp(amount * 0.09, 6, 34);
      const depth = Math.max(1, ...flap.map((p) => -side(p, fold)));
      const big = area(lifted) > W * H * 0.35;

      // 1. The crease throws a shadow onto what was underneath, darkest right at the fold.
      ctx.save();
      trace(lifted);
      ctx.clip();
      const spread = clamp(amount * 0.32, 22, 130);
      const contact = ctx.createLinearGradient(fold.m.x, fold.m.y, fold.m.x + fold.n.x * spread, fold.m.y + fold.n.y * spread);
      contact.addColorStop(0, `rgb(10 14 26 / ${palette.contact})`);
      contact.addColorStop(0.12, `rgb(10 14 26 / ${palette.contact * 0.55})`);
      contact.addColorStop(1, "rgb(10 14 26 / 0)");
      ctx.fillStyle = contact;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();

      // 2. The flap throws a soft shadow onto the sheet it is lying over.
      ctx.save();
      const blur = clamp(amount * 0.1, 5, big ? 14 : 26);
      const away = scale(fold.n, -Math.min(radius * 0.5, 10));
      ctx.shadowColor = palette.cast;
      ctx.shadowBlur = blur * dpr;
      ctx.shadowOffsetX = away.x * dpr;
      ctx.shadowOffsetY = (away.y + Math.min(radius * 0.4, 8)) * dpr;
      trace(flap);
      ctx.fillStyle = palette.base[1];
      ctx.fill();
      ctx.restore();

      // 3. The back of the sticker.
      drawBacking(fold, lifted);

      // 4. Light along the crease: the turned edge, a bright roll, then the flat of the flap.
      ctx.save();
      trace(flap);
      ctx.clip();
      const at = (px: number) => clamp(px / depth, 0, 1);
      const crease = ctx.createLinearGradient(fold.m.x, fold.m.y, fold.m.x - fold.n.x * depth, fold.m.y - fold.n.y * depth);
      crease.addColorStop(0, "rgb(0 0 0 / 0.16)");
      crease.addColorStop(at(radius * 0.32), `rgb(255 255 255 / ${palette.specular})`);
      crease.addColorStop(at(radius * 1.1), `rgb(255 255 255 / ${palette.specular * 0.18})`);
      crease.addColorStop(at(radius * 2.6), "rgb(0 0 0 / 0.03)");
      crease.addColorStop(1, "rgb(0 0 0 / 0.10)");
      ctx.fillStyle = crease;
      ctx.fillRect(0, 0, W, H);

      // 5. A shine along the crease that follows the pointer.
      if (pointer && (mode === "rest" || mode === "drag")) {
        const along = vec(-fold.n.y, fold.n.x);
        const onFold = add(fold.m, scale(along, dot(sub(pointer, fold.m), along)));
        const near = clamp(1 - Math.abs(side(pointer, fold)) / 420, 0, 1);
        if (near > 0) {
          const reach = 120 + radius * 4;
          const shine = ctx.createRadialGradient(onFold.x, onFold.y, 0, onFold.x, onFold.y, reach);
          shine.addColorStop(0, `rgb(255 255 255 / ${0.5 * near * near})`);
          shine.addColorStop(1, "rgb(255 255 255 / 0)");
          ctx.fillStyle = shine;
          ctx.fillRect(0, 0, W, H);
        }
      }
      ctx.restore();

      // 6. The paper's edge.
      ctx.lineWidth = 1;
      ctx.strokeStyle = palette.edge;
      trace(flap);
      ctx.stroke();
    }

    /* ── Motion ── */

    const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

    /** Where the corner goes to be entirely off the page: further along the way it is already lifting, bent toward the far corner. */
    function offPage(from: Vec): Vec {
      const C = corner();
      const diagonal = unit(vec(-W, -H));
      const heading = length(from) > 1 ? unit(lerp(unit(from), diagonal, 0.55)) : diagonal;
      return scale(heading, clearance(C, heading, rect(0, 0, W, H)) + 80);
    }

    function startOpening() {
      if (mode === "opening" || mode === "open") return;
      setPrimed(true);
      drag = null;
      peek = null;
      // The button that beckoned is about to be gone: it will never see the pointer leave.
      beckoning.current = false;
      document.documentElement.style.cursor = "";
      tween = { from: lift, to: offPage(lift), start: performance.now(), duration: reduced.matches ? 0 : 1050 };
      mode = "opening";
      density(sweepDensity());
      schedule();
    }

    function startClosing() {
      if (mode !== "open" && mode !== "opening") return;
      const from = mode === "open" ? offPage(scale(restDirection(), 1)) : lift;
      lift = from;
      mode = "closing";
      density(sweepDensity());
      setSettled(false);
      tween = { from, to: scale(restDirection(), restSize()), start: performance.now(), duration: reduced.matches ? 0 : 900 };
      schedule();
    }

    function settle() {
      mode = "open";
      tween = null;
      setSettled(true);
      draw();
      // Hand the keyboard to the first field, where a person would start typing. Not on touch: no surprise keyboard.
      if (!coarse.matches) {
        window.setTimeout(() => underEl!.querySelector<HTMLInputElement>("input:not([type=hidden])")?.focus({ preventScroll: true }), 60);
      }
    }

    function targetLift(now: number): Vec {
      if (drag) return goal;
      if (peek) {
        const t = (now - peek.start) / 1700;
        if (t >= 1) peek = null;
        else {
          const bump = Math.pow(Math.sin(Math.PI * clamp(t, 0, 1)), 2);
          return scale(restDirection(), restSize() + (clamp(Math.min(W, H) * 0.2, 120, 190) - restSize()) * bump);
        }
      }
      if (grip!.matches(":focus-visible")) return scale(restDirection(), tease().reach * 0.7);
      if (beckoning.current && !reduced.matches) return scale(restDirection(), tease().reach * 0.62);
      return teaseLift(corner(), reduced.matches ? null : pointer, tease());
    }

    function step(now: number) {
      raf = 0;
      const dt = Math.min((now - last) / 1000, 1 / 20);
      last = now;
      let moving = false;
      if ((mode === "opening" || mode === "closing") && tween) {
        const t = tween.duration <= 0 ? 1 : clamp((now - tween.start) / tween.duration, 0, 1);
        lift = lerp(tween.from, tween.to, ease(t));
        if (t >= 1) {
          if (mode === "opening") {
            settle();
            return;
          }
          mode = "rest";
          tween = null;
          density(fullDensity());
        } else moving = true;
      } else if (mode === "rest" || mode === "drag") {
        goal = targetLift(now);
        const tau = mode === "drag" ? 0.045 : 0.13;
        const k = reduced.matches ? 1 : 1 - Math.exp(-dt / tau);
        lift = lerp(lift, goal, k);
        moving = length(sub(goal, lift)) > 0.25 || peek !== null;
        if (!moving) lift = goal;
      }
      draw();
      if (moving) schedule();
    }

    function schedule() {
      if (!raf) {
        last = Math.min(last, performance.now());
        raf = requestAnimationFrame(step);
      }
    }

    /* ── The hand ── */

    // Only a pointer near the corner moves anything (the lift, the shine on the crease); elsewhere, nothing redraws.
    let near = false;
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      // Over a link or button on the page (the credit in the footer sits near the corner), the corner stays down: a
      // control that peels away as you reach for it cannot be clicked.
      const target = event.target instanceof Element ? event.target : null;
      const control = target?.closest("a, button, input, select, textarea, [role=button]");
      if (control && sheet.contains(control)) {
        pointer = null;
        if (mode === "rest" && near) schedule();
        near = false;
        return;
      }
      pointer = vec(event.clientX, event.clientY);
      const distance = length(sub(pointer, corner()));
      if (distance < tease().zone * 1.3) setPrimed(true);
      const nowNear = distance < Math.max(tease().zone, 520);
      if (mode === "rest" && (nowNear || near)) schedule();
      near = nowNear;
    };
    const onPointerOut = (event: PointerEvent) => {
      if (event.relatedTarget === null) {
        pointer = null;
        if (mode === "rest") schedule();
      }
    };

    const onGripDown = (event: PointerEvent) => {
      if (mode !== "rest" || (event.pointerType === "mouse" && event.button !== 0)) return;
      event.preventDefault();
      setPrimed(true);
      peek = null;
      suppressClick = false;
      const here = vec(event.clientX, event.clientY);
      const tip = add(corner(), lift);
      drag = { id: event.pointerId, start: here, offset: sub(tip, here), travelled: 0, last: here, at: performance.now(), velocity: vec(0, 0) };
      goal = lift;
      mode = "drag";
      try {
        grip!.setPointerCapture(event.pointerId);
      } catch {}
      document.documentElement.style.cursor = "grabbing";
      schedule();
    };
    const onGripMove = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      const here = vec(event.clientX, event.clientY);
      if (event.pointerType !== "touch") pointer = here;
      const now = performance.now();
      const dt = Math.max(now - drag.at, 1);
      drag.velocity = lerp(drag.velocity, scale(sub(here, drag.last), 1 / dt), 0.5);
      drag.last = here;
      drag.at = now;
      drag.travelled = Math.max(drag.travelled, length(sub(here, drag.start)));
      goal = sub(clampTip(corner(), add(here, drag.offset), W, H, restSize()), corner());
      schedule();
    };
    const onGripUp = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      const done = drag;
      drag = null;
      document.documentElement.style.cursor = "";
      suppressClick = true;
      window.setTimeout(() => (suppressClick = false), 500);
      if (event.type === "pointerup" && releasePeels(goal, done.travelled, done.velocity, W, H)) {
        mode = "rest";
        startOpening();
        peeledRef.current();
      } else {
        mode = "rest";
        schedule();
      }
    };
    const onGripClick = () => {
      // Keyboard (Enter, Space) lands here; a pointer was already handled on release.
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      if (mode !== "rest") return;
      startOpening();
      peeledRef.current();
    };
    const onGripFocus = () => {
      setPrimed(true);
      schedule();
    };

    const onResize = () => {
      measure();
      paint();
      schedule();
      if (mode === "open") draw();
    };
    const onScroll = () => {
      box = sheet.getBoundingClientRect();
      if (mode !== "open") schedule();
    };

    measure();
    paint();
    document.fonts?.ready.then(() => {
      paint();
      schedule();
    });
    const themeWatch = new MutationObserver(() => {
      paint();
      schedule();
    });
    themeWatch.observe(themeRoot, { attributes: true, attributeFilter: ["data-theme"] });
    const sizeWatch = new ResizeObserver(() => {
      box = sheet.getBoundingClientRect();
      schedule();
    });
    sizeWatch.observe(sheet);

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    document.documentElement.addEventListener("pointerout", onPointerOut, { passive: true });
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, { passive: true });
    grip.addEventListener("pointerdown", onGripDown);
    grip.addEventListener("pointermove", onGripMove);
    grip.addEventListener("pointerup", onGripUp);
    grip.addEventListener("pointercancel", onGripUp);
    grip.addEventListener("click", onGripClick);
    grip.addEventListener("focus", onGripFocus);
    grip.addEventListener("blur", onGripFocus);

    engine.current = {
      setOpen(next: boolean) {
        if (next) startOpening();
        else startClosing();
      },
      wake() {
        if (mode === "rest") schedule();
      },
    };

    if (mode === "open") {
      setSettled(true);
      draw();
    } else {
      draw();
      // Once a visit, the corner lifts by itself and settles back: the page shows how it opens.
      let shown = false;
      try {
        shown = sessionStorage.getItem("tessera-peel-shown") === "1";
        sessionStorage.setItem("tessera-peel-shown", "1");
      } catch {}
      if (!shown && !reduced.matches) {
        window.setTimeout(() => {
          if (mode === "rest" && !drag && !(pointer && length(sub(pointer, corner())) < tease().zone)) {
            peek = { start: performance.now() };
            schedule();
          }
        }, 1400);
      }
    }

    return () => {
      engine.current = null;
      cancelAnimationFrame(raf);
      themeWatch.disconnect();
      sizeWatch.disconnect();
      window.removeEventListener("pointermove", onPointerMove);
      document.documentElement.removeEventListener("pointerout", onPointerOut);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll);
      grip.removeEventListener("pointerdown", onGripDown);
      grip.removeEventListener("pointermove", onGripMove);
      grip.removeEventListener("pointerup", onGripUp);
      grip.removeEventListener("pointercancel", onGripUp);
      grip.removeEventListener("click", onGripClick);
      grip.removeEventListener("focus", onGripFocus);
      grip.removeEventListener("blur", onGripFocus);
      document.documentElement.style.cursor = "";
      sheet.style.clipPath = "";
      sheet.style.removeProperty("-webkit-clip-path");
    };
  }, []);

  return (
    <PeelContext.Provider value={{ prime, beckon }}>
      {/* Underneath: fixed behind the sheet while it is down, in the page's flow once the sheet is off. */}
      <div ref={underRef} inert={!settled} className={`desk z-0 ${settled ? "relative min-h-dvh" : "fixed inset-0 overflow-hidden"}`}>
        {primed ? under : null}
        <div aria-hidden className="pointer-events-none absolute inset-0 transition-opacity duration-300 [[data-peel=open]_&]:opacity-0 [[data-peel=opening]_&]:opacity-0">
          <div className="absolute bottom-0 right-0 size-[420px] bg-[radial-gradient(circle_at_100%_100%,color-mix(in_oklab,var(--accent)_30%,transparent)_0%,transparent_62%)]" />
          {hint}
        </div>
      </div>

      {/* The sheet: the page itself, live, cut along the fold. */}
      <div ref={sheetRef} inert={settled} className={`desk relative z-10 isolate ${settled ? "hidden" : ""}`}>
        {children}
      </div>

      {/* The paper: the folded-over back of the sheet, its light and its shadows. */}
      <canvas ref={canvasRef} aria-hidden className={`pointer-events-none fixed inset-0 z-50 h-full w-full ${settled ? "hidden" : ""}`} />

      {/* The corner, to take hold of: shaped like the lifted corner and its flap. */}
      <button
        ref={gripRef}
        type="button"
        aria-label={label}
        title={label}
        className={`invisible fixed inset-0 z-[51] cursor-grab touch-none bg-transparent outline-none ${settled ? "hidden" : ""}`}
      />
    </PeelContext.Provider>
  );
}
