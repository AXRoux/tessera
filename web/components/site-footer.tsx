import Link from "next/link";

const PAGE = [
  { href: "/", label: "Home" },
  { href: "/#how", label: "How it works" },
  { href: "/#console", label: "Live demo" },
  { href: "/#safety", label: "Safety" },
  { href: "/#proof", label: "Proof" },
  { href: "/#faq", label: "FAQ" },
];

const CODE = [
  { href: "https://github.com/AXRoux/tessera", label: "Source code" },
  { href: "https://github.com/AXRoux/tessera#use-it-from-any-mcp-client", label: "MCP guide" },
  { href: "https://github.com/AXRoux/tessera/blob/main/SPEC.md", label: "Specification" },
  { href: "https://github.com/AXRoux/tessera#honest-limits", label: "Honest limits" },
];

export function SiteFooter({ offline }: { offline: boolean }) {
  return (
    <footer className="relative mt-32 overflow-hidden">
      <div className="relative mx-auto max-w-[1200px] px-6 pt-8 sm:px-10">
        <div className="grid gap-12 md:grid-cols-[1.2fr_1fr]">
          <div>
            <p className="text-[15px] font-light uppercase tracking-[0.02em]">Money that moves once</p>
            <p className="mt-8 max-w-sm text-[16px] font-light leading-[1.45] text-soft">
              Tessera sits between your AI agents and your bank. The model reads, plain tested code decides, and every payment can be proved.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-10">
            <ul className="space-y-3 text-[18px] font-light">
              {PAGE.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} className="text-soft transition-colors hover:text-white">
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
            <ul className="space-y-3 text-[18px] font-light">
              {CODE.map((item) => (
                <li key={item.href}>
                  <a href={item.href} className="text-soft transition-colors hover:text-white">
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div aria-hidden className="fade-blue mt-16 select-none pb-4 text-[clamp(80px,17vw,230px)] font-bold leading-[0.9] tracking-[-0.08em]">
          Tessera.
        </div>
        <div className="relative -mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.08] py-6 text-[13px] font-light text-muted">
          <span>{offline ? "Running offline on a simulated Airwallex." : "Built on the Airwallex sandbox."} No real money moves.</span>
          <span>Tessera &middot; Money that moves once, and can prove it.</span>
        </div>
      </div>
    </footer>
  );
}
