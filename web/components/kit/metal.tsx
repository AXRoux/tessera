"use client";

import Link from "next/link";
import { MetalFx, redrawInstance, setCursorLightConfig, useMetalBend, type MetalFxPreset } from "metal-fx";
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type FocusEventHandler, type MouseEventHandler, type PointerEventHandler, type ReactNode } from "react";
import { useSurface } from "./theme";

type Tone = "primary" | "secondary" | "ink";

// The ring reflects on the page, never on the pointer itself.
if (typeof window !== "undefined") setCursorLightConfig({ cursor: false });

/**
 * Liquid metal around one control. The ring is a shared WebGL shader (one context for the whole page), dents where the
 * cursor presses it, and follows the surface it sits on, so a button on a black tile gets the dark-mode tuning even in
 * light mode. Disabled controls keep a still, faint ring: the shape is there, the life is not.
 */
export function Metal({
  children,
  variant = "button",
  preset = "chromatic",
  strength = 0.9,
  disabled = false,
  block = false,
  fill = "secondary",
  className = "",
}: {
  children: ReactNode;
  /** The surface under the ring. MetalFx makes the child transparent, so the fill lives on its root. */
  fill?: Tone;
  variant?: "button" | "circle";
  preset?: MetalFxPreset;
  strength?: number;
  disabled?: boolean;
  /** Fill the row: the wrapper and its child both take the full width. */
  block?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useMetalBend(ref);
  const surface = useSurface();
  // MetalFx renders a fallback on the server and its WebGL root on the client; mounting it after hydration keeps the
  // two renders identical, and the plain control is what shows for that first frame.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // MetalFx keeps the control hidden until its first frame lands. If the shared render loop is slow to start (a busy
  // page, a throttled GPU), ask for a frame directly; and if there is still none, show the plain control. A button on a
  // stage must never be invisible because a shader was late.
  useEffect(() => {
    if (!mounted) return;
    const root = ref.current;
    if (!root) return;
    const nudge = setTimeout(() => {
      const canvas = root.querySelector("canvas");
      if (root.style.visibility === "hidden" && canvas) redrawInstance(canvas);
    }, 250);
    const reveal = setTimeout(() => {
      if (root.style.visibility === "hidden") {
        root.style.visibility = "visible";
        root.style.opacity = "1";
      }
    }, 900);
    return () => {
      clearTimeout(nudge);
      clearTimeout(reveal);
    };
  }, [mounted]);
  if (!mounted) return <span className={`inline-flex ${block ? "flex! w-full" : ""} ${className}`}>{children}</span>;
  return (
    <MetalFx
      ref={ref}
      preset={preset}
      variant={variant}
      theme={surface}
      ringCssPx={variant === "button" ? 1.5 : 2}
      innerShadow
      strength={disabled ? 0.28 : strength}
      // The wandering halo reads as liquid light on a dark surface and as a smudge on a white one.
      glowGain={surface === "light" ? 0.35 : fill === "secondary" ? 0.55 : 1}
      disableGlow={disabled || (surface === "light" && fill === "secondary")}
      paused={disabled}
      className={`mfx-${fill} ${disabled ? "mfx-disabled" : ""} ${block ? "flex! w-full" : ""} ${className}`}
    >
      {children}
    </MetalFx>
  );
}

type Size = "sm" | "md";

const TONE: Record<Tone, string> = {
  // Airwallex blue under chromatic metal: the one call to action on a surface.
  primary: "bg-gradient-to-b from-[#3b82ff] to-[#1257f0] text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.35),0_8px_18px_-8px_rgb(29_104_255/0.7)]",
  // The surface's own material under silver: a pearl pill in light mode, obsidian in dark.
  secondary: "bg-gradient-to-b from-[var(--tile-top)] to-[var(--tile-bottom)] text-fg shadow-[var(--tile-shadow)]",
  // Ink: black in light mode, white in dark, for the strongest neutral action.
  ink: "bg-fg text-canvas",
};

const SIZE: Record<Size, string> = {
  sm: "h-9 px-4 text-[13px]",
  md: "h-11 px-5 text-[14px]",
};

const BASE =
  "inline-flex cursor-pointer select-none items-center justify-center gap-2 whitespace-nowrap rounded-full font-medium tracking-[-0.01em] transition-[transform,opacity] duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45 disabled:active:scale-100";

interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: Tone;
  size?: Size;
  busy?: boolean;
  block?: boolean;
  icon?: ReactNode;
}

/** A button in liquid metal. Every action in the control room is one of these. */
export function Btn({ tone = "primary", size = "sm", busy = false, block = false, icon, className = "", children, disabled, ...props }: BtnProps) {
  const off = Boolean(disabled || busy);
  return (
    <Metal fill={tone} preset={tone === "secondary" ? "silver" : "chromatic"} strength={tone === "secondary" ? 0.75 : 0.9} disabled={Boolean(disabled)} block={block}>
      <button {...props} disabled={off} className={`${BASE} ${SIZE[size]} ${TONE[tone]} ${block ? "w-full" : ""} ${className}`}>
        {busy ? <span aria-hidden className="size-3.5 rounded-full border-2 border-current border-t-transparent spin-slow" /> : icon}
        {children}
      </button>
    </Metal>
  );
}

/**
 * The same metal around a link, for actions that navigate. `onClick` may take the navigation over (the landing peels
 * itself away to sign-in): call `preventDefault()` and the link stays put; without script it is still a plain link.
 */
export function LinkBtn({
  href,
  tone = "primary",
  size = "sm",
  block = false,
  icon,
  className = "",
  children,
  onClick,
  onPointerEnter,
  onPointerLeave,
  onFocus,
  onBlur,
}: {
  href: string;
  tone?: Tone;
  size?: Size;
  block?: boolean;
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  onPointerEnter?: PointerEventHandler<HTMLAnchorElement>;
  onPointerLeave?: PointerEventHandler<HTMLAnchorElement>;
  onFocus?: FocusEventHandler<HTMLAnchorElement>;
  onBlur?: FocusEventHandler<HTMLAnchorElement>;
}) {
  return (
    <Metal fill={tone} preset={tone === "secondary" ? "silver" : "chromatic"} strength={tone === "secondary" ? 0.75 : 0.9} block={block}>
      <Link href={href} onClick={onClick} onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave} onFocus={onFocus} onBlur={onBlur} className={`${BASE} ${SIZE[size]} ${TONE[tone]} ${block ? "w-full" : ""} ${className}`}>
        {icon}
        {children}
      </Link>
    </Metal>
  );
}

/** A round metal control around an icon: back, bell, theme. */
export function MetalCircle({
  children,
  label,
  href,
  onClick,
  tone = "secondary",
  size = 44,
  className = "",
}: {
  children: ReactNode;
  label: string;
  href?: string;
  onClick?: () => void;
  tone?: Tone;
  size?: number;
  className?: string;
}) {
  const style = { width: size, height: size };
  const cls = `relative flex cursor-pointer items-center justify-center rounded-full transition-transform active:scale-95 ${TONE[tone]} ${className}`;
  return (
    <Metal fill={tone} variant="circle" preset={tone === "secondary" ? "silver" : "chromatic"} strength={tone === "secondary" ? 0.8 : 0.95}>
      {href ? (
        <Link href={href} aria-label={label} title={label} style={style} className={cls}>
          {children}
        </Link>
      ) : (
        <button type="button" onClick={onClick} aria-label={label} title={label} style={style} className={cls}>
          {children}
        </button>
      )}
    </Metal>
  );
}
