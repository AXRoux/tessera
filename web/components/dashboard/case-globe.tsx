"use client";

import { useEffect, useMemo, useRef } from "react";
import type { CaseOutcome, SupplierBadge } from "../../../src/server/wire";
import { GLOBE_DOTS, unitVector } from "@/lib/globe-dots";
import { GLOBE_REST, type Place } from "@/lib/supplier-places";
import { SupplierMark } from "../suppliers/supplier-mark";

/** Where a supplier's issue stands, as its pin shows it. `pending` is before the issues have been opened. */
export type PinState = "pending" | CaseOutcome["state"];

export interface GlobePin {
  id: string;
  supplier: Pick<SupplierBadge, "id" | "name" | "tile">;
  place: Place;
  state: PinState;
  /** The agent's current tool call names this supplier's invoice. */
  working: boolean;
}

const RING: Record<PinState, string> = {
  pending: "ring-bad/70",
  open: "ring-bad",
  working: "ring-accent",
  yours: "ring-warn",
  solved: "ring-ok",
  certified: "ring-ok",
};
const DOT: Record<PinState, string> = {
  pending: "bg-bad",
  open: "bg-bad",
  working: "bg-accent",
  yours: "bg-warn",
  solved: "bg-ok",
  certified: "bg-ok",
};

const DEG = Math.PI / 180;
/** Brightness buckets for the dots, nearest the viewer brightest: one path per bucket keeps a frame to a few fills. */
const BUCKETS = 6;

/** The orthographic view facing (lat, lon): east, north and toward-the-viewer axes, as unit vectors. */
function axes(lat: number, lon: number) {
  const p = lat * DEG;
  const l = lon * DEG;
  return {
    e: [-Math.sin(l), Math.cos(l), 0] as const,
    n: [-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p)] as const,
    v: [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)] as const,
  };
}

/** "rgb(243, 244, 246)" to its three channels. */
const channels = (color: string): [number, number, number] => {
  const m = color.match(/\d+(\.\d+)?/g);
  return m && m.length >= 3 ? [Number(m[0]), Number(m[1]), Number(m[2])] : [255, 255, 255];
};

/**
 * The case map: a dotted globe, drawn on a canvas in the room's own ink, with each supplier pinned at its headquarters
 * (src: web/lib/supplier-places.ts). It drifts slowly at rest (not when motion is reduced), and spins when dragged. Pins
 * are real buttons laid over the canvas and moved with it each frame; a pin on the far side is hidden. Suppliers in one
 * metro fan out around it, each with a leader line back to its own point.
 */
export function CaseGlobe({
  pins,
  selected,
  onSelect,
  className = "",
}: {
  pins: GlobePin[];
  selected: string | null;
  onSelect?: (id: string) => void;
  className?: string;
}) {
  // Where the globe faces now, and where it is easing to: at rest, or turned so the chosen supplier sits left of centre,
  // clear of its case card on the right.
  const focus = pins.find((p) => p.id === selected)?.place ?? null;
  const target = focus ? { lat: Math.max(-20, Math.min(70, focus.lat - 4)), lon: focus.lon + 30 } : GLOBE_REST;
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const pinEls = useRef(new Map<string, HTMLElement>());
  // Read by the frame loop, so a new board does not restart it.
  const live = useRef({ pins, view: { ...GLOBE_REST }, target: { ...GLOBE_REST }, focused: false, hovering: false });
  live.current.pins = pins;
  live.current.focused = focus !== null;
  useEffect(() => {
    live.current.target = { ...target };
  }, [target.lat, target.lon]); // eslint-disable-line react-hooks/exhaustive-deps

  // Suppliers in one metro fan out around it: the first at the top, the rest clockwise. Each keeps its own true point.
  const layout = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const pin of pins) groups.set(pin.place.metro, [...(groups.get(pin.place.metro) ?? []), pin.id]);
    const offsets = new Map<string, [number, number]>();
    for (const ids of groups.values()) {
      ids.forEach((id, i) => {
        const angle = -Math.PI / 2 + (i * 2 * Math.PI) / ids.length;
        const r = ids.length > 1 ? 25 : 0;
        offsets.set(id, [Math.cos(angle) * r, Math.sin(angle) * r]);
      });
    }
    return offsets;
  }, [pins]);
  const offsets = useRef(layout);
  offsets.current = layout;

  useEffect(() => {
    const el = canvas.current;
    const holder = box.current;
    if (!el || !holder) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let width = 0;
    let height = 0;
    let ink: [number, number, number] = [255, 255, 255];
    let frame = 0;
    let raf = 0;
    // The drift runs on its own clock, which stops while the pointer is over the globe, a supplier is open or it is being
    // dragged: a pin holds still to be clicked, and the globe picks up where it stopped.
    let phase = 0;
    let last = performance.now();
    let dragging: { x: number; y: number; lon: number; lat: number; R: number } | null = null;

    const resize = () => {
      const rect = holder.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;
      el.width = Math.round(width * dpr);
      el.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ink = channels(getComputedStyle(holder).color);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(holder);

    const draw = (now: number) => {
      // The ink follows the theme; reading it now and then is enough.
      if (++frame % 90 === 0) ink = channels(getComputedStyle(holder).color);
      const rgba = (a: number) => `rgba(${ink[0]},${ink[1]},${ink[2]},${a})`;
      // Ease toward the target; drift slowly around it while nothing is chosen.
      const { view, target: aim } = live.current;
      const ease = reduced ? 1 : 0.07;
      // Ease toward the target, and land on it: an endless approach would leave the pins creeping by fractions of a pixel.
      view.lon = Math.abs(aim.lon - view.lon) < 0.01 ? aim.lon : view.lon + (aim.lon - view.lon) * ease;
      view.lat = Math.abs(aim.lat - view.lat) < 0.01 ? aim.lat : view.lat + (aim.lat - view.lat) * ease;
      const still = reduced || live.current.focused || live.current.hovering || dragging !== null;
      if (!still) phase += now - last;
      last = now;
      const drift = reduced ? 0 : 6 * Math.sin((phase / 26_000) * 2 * Math.PI);
      const lon = view.lon + drift;
      const lat = Math.max(-20, Math.min(70, view.lat));
      const { e, n, v } = axes(lat, lon);
      // Set a little left of centre on a wide map, so the panels on the right cover ocean rather than suppliers.
      const R = Math.max(60, Math.min(width * 0.45, height * 0.47));
      const cx = width > 520 ? width * 0.43 : width / 2;
      const cy = height * 0.49;
      const scale = R / 240;

      ctx.clearRect(0, 0, width, height);
      // The sphere itself: a faint fill lit from the upper left, a hairline rim, and a soft halo around it.
      const halo = ctx.createRadialGradient(cx, cy, R * 0.96, cx, cy, R * 1.12);
      halo.addColorStop(0, rgba(0.07));
      halo.addColorStop(1, rgba(0));
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.12, 0, Math.PI * 2);
      ctx.fill();
      const body = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.05, cx, cy, R);
      body.addColorStop(0, rgba(0.075));
      body.addColorStop(1, rgba(0.012));
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = rgba(0.16);
      ctx.lineWidth = 1;
      ctx.stroke();

      // Land, as dots: brighter and larger toward the viewer, fading into the limb.
      const paths = Array.from({ length: BUCKETS }, () => new Path2D());
      for (let i = 0; i < GLOBE_DOTS.length; i += 3) {
        const px = GLOBE_DOTS[i]!;
        const py = GLOBE_DOTS[i + 1]!;
        const pz = GLOBE_DOTS[i + 2]!;
        const z = px * v[0] + py * v[1] + pz * v[2];
        if (z <= 0.03) continue;
        const x = px * e[0] + py * e[1];
        const y = px * n[0] + py * n[1] + pz * n[2];
        const b = Math.min(BUCKETS - 1, Math.floor(z * BUCKETS));
        const r = (0.55 + 0.17 * b) * scale + 0.25;
        const sx = cx + x * R;
        const sy = cy - y * R;
        paths[b]!.moveTo(sx + r, sy);
        paths[b]!.arc(sx, sy, r, 0, Math.PI * 2);
      }
      paths.forEach((path, b) => {
        ctx.fillStyle = rgba(0.13 + 0.135 * b);
        ctx.fill(path);
      });

      // Each supplier's true point, projected; a metro's pins fan out around the centre of its points.
      const project = (lat: number, lon: number) => {
        const [qx, qy, qz] = unitVector(lat, lon);
        return {
          x: cx + (qx * e[0] + qy * e[1]) * R,
          y: cy - (qx * n[0] + qy * n[1] + qz * n[2]) * R,
          z: qx * v[0] + qy * v[1] + qz * v[2],
        };
      };
      const points = live.current.pins.map((pin) => ({ pin, at: project(pin.place.lat, pin.place.lon) }));
      const metros = new Map<string, { x: number; y: number; n: number }>();
      for (const { pin, at } of points) {
        const m = metros.get(pin.place.metro) ?? { x: 0, y: 0, n: 0 };
        metros.set(pin.place.metro, { x: m.x + at.x, y: m.y + at.y, n: m.n + 1 });
      }
      const drawn = new Set<string>();
      for (const { pin, at } of points) {
        const m = metros.get(pin.place.metro)!;
        const [ox, oy] = offsets.current.get(pin.id) ?? [0, 0];
        const px = m.x / m.n + ox;
        const py = m.y / m.n + oy;
        const shown = at.z > 0.12;
        const node = pinEls.current.get(pin.id);
        if (node) {
          node.style.transform = `translate3d(${px}px, ${py}px, 0) translate(-50%, -50%)`;
          node.style.opacity = shown ? String(Math.min(1, (at.z - 0.12) * 6)) : "0";
          node.style.pointerEvents = shown ? "auto" : "none";
        }
        if (at.z <= 0.05) continue;
        // A leader line from the pin back to the supplier's own point.
        if (ox !== 0 || oy !== 0) {
          ctx.strokeStyle = rgba(0.32);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(at.x, at.y);
          ctx.lineTo(px, py);
          ctx.stroke();
        }
        const key = `${pin.place.lat},${pin.place.lon}`;
        if (drawn.has(key)) continue;
        drawn.add(key);
        const glow = ctx.createRadialGradient(at.x, at.y, 0, at.x, at.y, 18 * scale + 6);
        glow.addColorStop(0, rgba(0.25));
        glow.addColorStop(1, rgba(0));
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(at.x, at.y, 18 * scale + 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = rgba(0.95);
        ctx.beginPath();
        ctx.arc(at.x, at.y, 2, 0, Math.PI * 2);
        ctx.fill();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    // Drag to spin: a pixel of drag turns the globe by the angle that pixel spans at the centre.
    const down = (event: PointerEvent) => {
      el.setPointerCapture(event.pointerId);
      dragging = { x: event.clientX, y: event.clientY, lon: live.current.view.lon, lat: live.current.view.lat, R: Math.max(60, Math.min(width, height) * 0.47) };
    };
    const move = (event: PointerEvent) => {
      if (!dragging) return;
      const perPx = 180 / (Math.PI * dragging.R);
      const next = { lon: dragging.lon - (event.clientX - dragging.x) * perPx, lat: Math.max(-20, Math.min(70, dragging.lat + (event.clientY - dragging.y) * perPx)) };
      live.current.view = { ...next };
      live.current.target = { ...next };
    };
    const up = () => {
      dragging = null;
    };
    const enter = () => {
      live.current.hovering = true;
    };
    const leave = () => {
      live.current.hovering = false;
    };
    holder.addEventListener("pointerenter", enter);
    holder.addEventListener("pointerleave", leave);
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      holder.removeEventListener("pointerenter", enter);
      holder.removeEventListener("pointerleave", leave);
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
  }, []);

  return (
    <div ref={box} className={`relative h-full w-full overflow-hidden text-fg ${className}`}>
      <canvas ref={canvas} aria-hidden className="absolute inset-0 h-full w-full cursor-grab touch-none active:cursor-grabbing" />
      {pins.map((pin) => {
        const on = pin.id === selected;
        const ring = on ? "ring-[3px] ring-fg" : `ring-2 ${RING[pin.state]}`;
        return (
          <button
            key={pin.id}
            ref={(node) => {
              if (node) pinEls.current.set(pin.id, node);
              else pinEls.current.delete(pin.id);
            }}
            type="button"
            disabled={!onSelect}
            onClick={() => onSelect?.(pin.id)}
            aria-pressed={on}
            aria-label={`${pin.supplier.name}, ${pin.place.address}`}
            className={`group absolute left-0 top-0 opacity-0 outline-none transition-[scale] duration-300 will-change-transform ${on ? "z-20 scale-110" : "z-10 hover:z-20 hover:scale-110"} ${onSelect ? "cursor-pointer" : "cursor-default"}`}
          >
            <span className="relative block">
              {pin.state === "open" || pin.state === "pending" ? <span aria-hidden className="absolute -inset-1.5 animate-ping rounded-full bg-bad/25 [animation-duration:2.2s]" /> : null}
              {pin.working ? <span aria-hidden className="absolute -inset-[5px] animate-pulse rounded-full ring-2 ring-accent" /> : null}
              <span className={`relative flex size-[38px] items-center justify-center overflow-hidden rounded-full bg-canvas shadow-[0_6px_18px_-6px_rgb(0_0_0/0.6)] ${ring}`}>
                <SupplierMark supplier={pin.supplier} size={38} />
              </span>
              <span aria-hidden className={`absolute -bottom-px -right-px size-3 rounded-full ring-2 ring-[var(--tile-top)] ${DOT[pin.state]}`} />
            </span>
            <span
              className={`pointer-events-none absolute left-1/2 top-full mt-2 -translate-x-1/2 whitespace-nowrap rounded-full bg-[var(--tile-top)] px-2.5 py-1 text-[11.5px] font-medium text-fg shadow-[0_8px_20px_-8px_rgb(0_0_0/0.6)] ring-1 ring-fg/10 transition-opacity ${on ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"}`}
            >
              {pin.supplier.name}
              <span className="text-fg/45"> · {pin.place.address}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
