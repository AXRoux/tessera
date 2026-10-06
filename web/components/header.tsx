import Link from "next/link";
import { Tag } from "./ui";

/** Black square with a blue 45-degree notch: the lock and the cut corner in one shape. */
export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden>
      <polygon points="0,0 28,0 28,28 0,28" fill="#0b0d12" />
      <polygon points="14,0 28,0 28,14" fill="#1f4dff" />
      <rect x="8" y="12" width="12" height="9" fill="#ffffff" />
      <polygon points="11,12 11,8 17,8 17,12 15.5,12 15.5,9.5 12.5,9.5 12.5,12" fill="#ffffff" />
    </svg>
  );
}

export function Header() {
  return (
    <header className="border-b border-rule">
      <div className="mx-auto flex h-[72px] max-w-[1440px] items-center justify-between px-6 sm:px-10">
        <Link href="/" className="flex items-center gap-3" aria-label="PayOnce home">
          <Mark />
          <span className="font-display text-[17px] tracking-[0.08em]">PAYONCE</span>
        </Link>
        <nav className="flex items-center gap-8">
          <Link href="/" className="label text-ink hover:text-blue">
            Incidents
          </Link>
          <Link href="/#method" className="label hover:text-blue">
            Method
          </Link>
          <span className="hidden sm:inline">
            <Tag tone="blue-outline">Sandbox</Tag>
          </span>
        </nav>
      </div>
    </header>
  );
}
