import type { ButtonHTMLAttributes, ReactNode } from "react";

export type Tone = "ink" | "blue" | "outline" | "blue-outline" | "muted";

const TONE: Record<Tone, string> = {
  ink: "bg-ink text-paper",
  blue: "bg-blue text-paper",
  outline: "border border-ink text-ink",
  "blue-outline": "border border-blue text-blue",
  muted: "border border-rule text-muted",
};

/** A rectangular status tag with a square marker. `pulse` makes the marker blink for things still in motion. */
export function Tag({ tone = "outline", pulse = false, children }: { tone?: Tone; pulse?: boolean; children: ReactNode }) {
  return (
    <span className={`inline-flex h-7 items-center gap-2 px-3 text-[11px] font-medium uppercase tracking-[0.16em] ${TONE[tone]}`}>
      <span aria-hidden className={`size-2 bg-current ${pulse ? "beat" : ""}`} />
      {children}
    </span>
  );
}

export function Label({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`label ${className}`}>{children}</span>;
}

type Variant = "primary" | "secondary" | "quiet";

const VARIANT: Record<Variant, string> = {
  primary: "chamfer bg-ink text-paper hover:bg-blue disabled:bg-disabled disabled:text-paper",
  secondary: "border border-ink text-ink hover:bg-ink hover:text-paper disabled:border-rule disabled:text-muted disabled:hover:bg-transparent disabled:hover:text-muted disabled:hatch",
  quiet: "h-auto px-0 text-ink underline decoration-rule decoration-2 underline-offset-[6px] hover:text-blue hover:decoration-blue disabled:text-muted",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  busy?: boolean;
}

/** Rectangular buttons. The primary action carries the chamfer; nothing is ever rounded. */
export function Button({ variant = "primary", busy = false, className = "", children, disabled, ...props }: ButtonProps) {
  return (
    <button
      {...props}
      disabled={disabled || busy}
      className={`inline-flex h-12 cursor-pointer items-center justify-center gap-3 px-6 text-[12px] font-medium uppercase tracking-[0.18em] transition-colors disabled:cursor-not-allowed ${VARIANT[variant]} ${className}`}
    >
      {busy ? <span aria-hidden className="beat size-2 bg-blue" /> : null}
      {children}
    </button>
  );
}

/** A frame with the signature cut corners. The 1px outline is drawn by nesting two clipped shapes. */
export function Frame({ children, className = "", tone = "ink" }: { children: ReactNode; className?: string; tone?: "ink" | "blue" | "rule" }) {
  const outline = tone === "blue" ? "bg-blue" : tone === "rule" ? "bg-rule" : "bg-ink";
  return (
    <div className={`chamfer p-px ${outline} ${className}`}>
      <div className="chamfer h-full bg-paper">{children}</div>
    </div>
  );
}

export function PanelHeader({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="flex h-12 items-center justify-between border-b border-rule px-5">
      <Label className="text-ink">{title}</Label>
      {right}
    </div>
  );
}

export function Stat({ value, unit, label }: { value: ReactNode; unit?: string; label: string }) {
  return (
    <div className="py-5 pl-6 pr-4 first:pl-0">
      <div className="flex items-baseline gap-1.5">
        <span className="tnum text-[40px] font-semibold leading-none">{value}</span>
        {unit ? <span className="text-sm font-semibold">{unit}</span> : null}
      </div>
      <p className="mt-2 text-sm text-muted">{label}</p>
    </div>
  );
}

/** The spec strip: large numerals separated by hairline rules. */
export function StatStrip({ children, columns = 4 }: { children: ReactNode; columns?: 2 | 3 | 4 }) {
  const grid = columns === 2 ? "grid-cols-2" : columns === 3 ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-2 lg:grid-cols-4";
  return (
    <div className="border-y border-rule">
      <div className={`mx-auto grid max-w-[1440px] ${grid} divide-x divide-rule px-6 sm:px-10`}>{children}</div>
    </div>
  );
}

/** A numbered square, used for sequence and for the principles list. */
export function Index({ n }: { n: number | string }) {
  return (
    <span className="inline-flex size-8 shrink-0 items-center justify-center bg-ink font-display text-[11px] text-paper tnum">
      {typeof n === "number" ? String(n).padStart(2, "0") : n}
    </span>
  );
}
