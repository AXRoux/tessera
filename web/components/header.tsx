import Link from "next/link";
import { Logo } from "./logo";
import { TourLink } from "./tour";
import { Tag } from "./ui";

export function Header({ offline, tour }: { offline: boolean; tour: boolean }) {
  return (
    <header className="border-b border-rule">
      <div className="mx-auto flex h-[72px] max-w-[1440px] items-center justify-between px-6 sm:px-10">
        <Link href="/" className="flex shrink-0 items-center gap-3" aria-label="Tessera home">
          <Logo size={34} />
          <span className="font-display text-[17px] tracking-[0.08em]">TESSERA</span>
        </Link>
        <nav className="flex items-center gap-5 whitespace-nowrap sm:gap-8">
          <Link href="/" className="label hidden text-ink hover:text-blue sm:inline">
            Incidents
          </Link>
          <Link href="/#method" className="label hidden hover:text-blue sm:inline">
            Method
          </Link>
          {tour ? <TourLink /> : null}
          <span className="hidden sm:inline">
            <Tag tone="blue-outline">{offline ? "Offline demo" : "Sandbox"}</Tag>
          </span>
        </nav>
      </div>
    </header>
  );
}
