"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useTheme } from "@/components/kit/theme";
import { Toggle } from "@/components/kit/widgets";
import { Barcode } from "@/components/landing/landing";
import { Icon } from "@/components/landing/icons";
import { Logo } from "@/components/logo";

export interface LegalSection {
  heading: string;
  body: ReactNode;
}

/**
 * The shell for the two legal documents. One poster page each, numbered like the rest of the site, on the palette the
 * person last chose. The sibling link is the other document, so neither ever dead-ends.
 */
export function LegalShell({
  label,
  title,
  standfirst,
  updated,
  sections,
  sibling,
}: {
  label: string;
  title: string;
  standfirst: string;
  updated: string;
  sections: LegalSection[];
  sibling: { href: string; label: string };
}) {
  const { theme, setTheme } = useTheme();
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[880px] flex-col px-6 pb-14 pt-6 sm:px-8">
      <header className="flex items-center justify-between gap-4">
        <Link href="/" className="flex items-center gap-2.5" aria-label="Tessera home">
          <span className="tile flex size-9 items-center justify-center rounded-[11px]!">
            <Logo size={20} />
          </span>
          <span className="cond text-[19px]">Tessera</span>
        </Link>
        <div className="flex items-center gap-5">
          <nav aria-label="Legal" className="micro hidden items-center gap-5 text-fg/60 sm:flex">
            <Link href={sibling.href} className="hover:text-fg">
              {sibling.label}
            </Link>
            <Link href="/" className="hover:text-fg">
              Home
            </Link>
          </nav>
          <Toggle
            label="Appearance"
            value={theme}
            onChange={setTheme}
            options={[
              { id: "light", label: <Icon name="sun" className="size-4" />, title: "Light" },
              { id: "dark", label: <Icon name="moon" className="size-4" />, title: "Dark" },
            ]}
          />
        </div>
      </header>

      <p className="kicker mt-14">Tessera · Legal · {label}</p>
      <h1 className="cond mt-3 text-[clamp(36px,6vw,56px)] leading-[0.98] tracking-[-0.01em]">{title}</h1>
      <p className="mt-4 max-w-[64ch] text-[15px] leading-relaxed text-fg/70">{standfirst}</p>
      <p className="kicker mt-5">Updated {updated}</p>

      <ol className="mt-10">
        {sections.map((section, i) => (
          <li key={section.heading} className="grid grid-cols-[34px_1fr] gap-x-5 border-t border-rule py-6 sm:grid-cols-[60px_1fr]">
            <span className="kicker pt-1">{String(i + 1).padStart(2, "0")}</span>
            <div>
              <h2 className="text-[15.5px] font-semibold tracking-[-0.01em]">{section.heading}</h2>
              <div className="mt-2 max-w-[68ch] space-y-2 text-[13.5px] leading-relaxed text-fg/70">{section.body}</div>
            </div>
          </li>
        ))}
      </ol>

      <footer className="mt-auto flex items-end justify-between gap-6 border-t border-rule pt-6">
        <p className="kicker">Sandbox only · no real money</p>
        <div className="flex items-center gap-5">
          <Link href={sibling.href} className="micro text-fg/60 hover:text-fg">
            {sibling.label}
          </Link>
          <Barcode text={`TESSERA-${label.toUpperCase()}`} className="h-5 w-28 text-fg/45" />
        </div>
      </footer>
    </main>
  );
}
