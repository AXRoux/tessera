import Link from "next/link";
import { Logo } from "./logo";
import { Tag } from "./ui";

export function Header() {
  return (
    <header className="border-b border-rule">
      <div className="mx-auto flex h-[72px] max-w-[1440px] items-center justify-between px-6 sm:px-10">
        <Link href="/" className="flex items-center gap-3" aria-label="Tessera home">
          <Logo size={34} />
          <span className="font-display text-[17px] tracking-[0.08em]">TESSERA</span>
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
