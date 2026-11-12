import Link from "next/link";
import { Logo } from "./logo";
import { TourLink } from "./tour";

const NAV = [
  { href: "/#how", label: "How it works" },
  { href: "/#console", label: "Live demo" },
  { href: "/#safety", label: "Safety" },
  { href: "/#proof", label: "Proof" },
  { href: "/#faq", label: "FAQ" },
];

export function Header({ offline, tour }: { offline: boolean; tour: boolean }) {
  return (
    <header className="sticky top-0 z-40 border-b border-white/[0.06] bg-paper/55 backdrop-blur-xl">
      <div className="mx-auto flex h-[76px] max-w-[1200px] items-center justify-between gap-6 px-6 sm:px-10">
        <div className="flex items-center gap-10">
          <Link href="/" className="flex shrink-0 items-center gap-3" aria-label="Tessera home">
            <Logo size={34} />
            <span className="text-[20px] font-medium tracking-[-0.04em]">Tessera</span>
          </Link>
          <nav aria-label="Sections" className="hidden items-center gap-7 lg:flex">
            {NAV.map((item) => (
              <Link key={item.href} href={item.href} className="text-[14px] font-light text-soft transition-colors hover:text-white">
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-4">
          <span className="hidden items-center gap-2 text-[13px] font-light text-muted md:inline-flex">
            <span aria-hidden className="size-1.5 rounded-full bg-sky" />
            {offline ? "Offline demo" : "Airwallex sandbox"}
          </span>
          {tour ? (
            <TourLink />
          ) : (
            <Link
              href="https://github.com/AXRoux/tessera"
              className="inline-flex h-11 items-center rounded-full border border-white/40 px-5 text-[14px] transition-colors hover:bg-white/10"
            >
              View the code
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
