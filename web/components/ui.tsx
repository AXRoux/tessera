import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export type Tone = "ink" | "blue" | "outline" | "blue-outline" | "muted";

const TONE: Record<Tone, string> = {
  ink: "bg-ink text-paper",
  blue: "bg-blue text-white",
  outline: "border border-white/30 text-ink",
  "blue-outline": "border border-sky/45 bg-wash text-sky",
  muted: "border border-rule text-muted",
};

/** A status pill with a dot. `pulse` makes the dot breathe for things still in motion. */
export function Tag({ tone = "outline", pulse = false, children }: { tone?: Tone; pulse?: boolean; children: ReactNode }) {
  return (
    <span className={`inline-flex h-7 items-center gap-2 whitespace-nowrap rounded-full px-3 text-[12px] font-medium tracking-[0.01em] ${TONE[tone]}`}>
      <span aria-hidden className={`size-1.5 rounded-full bg-current ${pulse ? "beat" : ""}`} />
      {children}
    </span>
  );
}

export function Label({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`label ${className}`}>{children}</span>;
}

/** The frosted eyebrow pill that introduces a section. */
export function Eyebrow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span className={`glass inline-flex items-center px-3 py-1.5 text-[14px] font-normal text-ink ${className}`}>{children}</span>
  );
}

/** A circled arrow, the mark of a primary call to action. */
export function ArrowDot({ className = "" }: { className?: string }) {
  return (
    <span aria-hidden className={`inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-white text-sky ${className}`}>
      <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 8h10M9 4l4 4-4 4" />
      </svg>
    </span>
  );
}

type Variant = "primary" | "secondary" | "light" | "quiet";
type Size = "sm" | "md" | "lg";

const VARIANT: Record<Variant, string> = {
  primary: "bg-blue text-white hover:bg-[#6464ff] disabled:bg-blue/35 disabled:text-white/60",
  secondary:
    "border border-white/35 text-ink hover:border-white hover:bg-white/10 disabled:border-rule disabled:text-muted disabled:hover:bg-transparent",
  light: "bg-white text-black hover:bg-white/85 disabled:bg-white/25 disabled:text-white/50",
  quiet:
    "h-auto rounded-none px-0 text-ink underline decoration-white/30 decoration-1 underline-offset-[6px] hover:decoration-sky disabled:text-muted",
};

const SIZE: Record<Size, string> = {
  sm: "h-9 px-4 text-[13px] gap-2",
  md: "h-11 px-5 text-[14px]",
  lg: "h-16 px-6 text-[16px]",
};

const BASE =
  "inline-flex cursor-pointer items-center justify-center gap-3 whitespace-nowrap rounded-full font-normal tracking-[-0.01em] transition-colors duration-200 disabled:cursor-not-allowed";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  busy?: boolean;
  arrow?: boolean;
}

export function Button({ variant = "primary", size = "md", busy = false, arrow = false, className = "", children, disabled, ...props }: ButtonProps) {
  return (
    <button {...props} disabled={disabled || busy} className={`${BASE} ${SIZE[size]} ${VARIANT[variant]} ${className}`}>
      {busy ? <span aria-hidden className="beat size-2 rounded-full bg-current" /> : null}
      {children}
      {arrow && !busy ? <ArrowDot /> : null}
    </button>
  );
}

/** A link that looks like a Button, for actions that navigate. */
export function LinkButton({
  href,
  variant = "primary",
  size = "md",
  arrow = false,
  className = "",
  onClick,
  children,
}: {
  href: string;
  variant?: Variant;
  size?: Size;
  arrow?: boolean;
  className?: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <Link href={href} onClick={onClick} className={`${BASE} ${SIZE[size]} ${VARIANT[variant]} ${className}`}>
      {children}
      {arrow ? <ArrowDot /> : null}
    </Link>
  );
}

const FRAME: Record<"ink" | "blue" | "rule", string> = {
  ink: "border-white/25",
  blue: "border-blue/60",
  rule: "border-white/[0.08]",
};

/** A soft, rounded panel. The border colour carries the panel's importance. */
export function Frame({ children, className = "", tone = "ink" }: { children: ReactNode; className?: string; tone?: "ink" | "blue" | "rule" }) {
  return <div className={`overflow-hidden rounded-[20px] border bg-surface ${FRAME[tone]} ${className}`}>{children}</div>;
}

export function PanelHeader({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="flex min-h-14 items-center justify-between gap-4 border-b border-rule px-6 py-3">
      <span className="truncate text-[15px] font-medium tracking-[-0.01em] text-ink">{title}</span>
      {right}
    </div>
  );
}

export function Stat({ value, unit, label }: { value: ReactNode; unit?: string; label: string }) {
  return (
    <div className="p-6">
      <div className="flex items-baseline gap-1.5">
        <span className="tnum text-[34px] font-light leading-none tracking-[-0.04em]">{value}</span>
        {unit ? <span className="text-sm font-medium">{unit}</span> : null}
      </div>
      <p className="mt-3 text-[13px] leading-snug text-muted">{label}</p>
    </div>
  );
}

/** The spec strip: large light numerals in one rounded card, split by hairlines. */
export function StatStrip({ children, columns = 4 }: { children: ReactNode; columns?: 2 | 3 | 4 | 6 }) {
  const grid =
    columns === 2 ? "grid-cols-2" : columns === 3 ? "grid-cols-2 sm:grid-cols-3" : columns === 6 ? "grid-cols-2 sm:grid-cols-3 xl:grid-cols-6" : "grid-cols-2 lg:grid-cols-4";
  return (
    <div className="mx-auto max-w-[1200px] px-6 sm:px-10">
      <div className={`grid ${grid} gap-px overflow-hidden rounded-[20px] border border-white/[0.08] bg-rule [&>*]:bg-surface`}>{children}</div>
    </div>
  );
}

/** A numbered disc, used for sequence and for lists of reasons. */
export function Index({ n }: { n: number | string }) {
  return (
    <span className="tnum inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-white/25 bg-white/[0.06] text-[12px] font-medium text-ink">
      {typeof n === "number" ? n : n}
    </span>
  );
}
