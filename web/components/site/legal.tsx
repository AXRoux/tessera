"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { useTheme } from "@/components/kit/theme";
import { Toggle } from "@/components/kit/widgets";
import { Barcode } from "@/components/landing/landing";
import { Icon } from "@/components/landing/icons";
import { Logo } from "@/components/logo";

export interface LegalSection {
  heading: string;
  /** One plain sentence: what the section means for you. Shown above the full text. */
  summary?: string;
  body: ReactNode;
}

export interface LegalGlance {
  title: string;
  text: string;
}

export interface LegalMeta {
  effective: string;
  version: string;
  appliesTo: string;
}

const slug = (heading: string): string =>
  heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * Long-form text inside a section: paragraphs, lists, definition rows, tables and callouts, styled once here so each
 * document is plain JSX.
 */
const PROSE = [
  "space-y-3 text-[14px] leading-[1.7] text-fg/75",
  "[&_strong]:font-semibold [&_strong]:text-fg",
  "[&_a]:text-accent [&_a]:underline [&_a]:decoration-accent/35 [&_a]:underline-offset-[3px] hover:[&_a]:decoration-accent",
  "[&_ul]:space-y-1.5 [&_ul]:pl-0 [&_ul>li]:relative [&_ul>li]:pl-5 [&_ul>li]:before:absolute [&_ul>li]:before:left-0 [&_ul>li]:before:top-[0.72em] [&_ul>li]:before:size-[5px] [&_ul>li]:before:bg-accent [&_ul>li]:before:content-['']",
  "[&_ol]:list-decimal [&_ol]:space-y-1.5 [&_ol]:pl-5 [&_ol>li]:pl-1 [&_ol>li]:marker:text-fg/45 [&_ol>li]:marker:font-plex",
  "[&_code]:rounded-[5px] [&_code]:bg-fg/[0.06] [&_code]:px-1.5 [&_code]:py-px [&_code]:font-plex [&_code]:text-[12.5px] [&_code]:text-fg/85",
  "[&_h3]:pt-2 [&_h3]:text-[13.5px] [&_h3]:font-semibold [&_h3]:text-fg",
].join(" ");

/** A row-and-column table for the facts a reader compares: what is held, by whom, for how long. */
export function LegalTable({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="well my-4 overflow-x-auto rounded-[16px]!">
      <table className="w-full border-collapse text-left text-[13px] leading-relaxed">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} className="micro whitespace-nowrap border-b border-fg/10 px-4 py-3 font-normal text-fg/55">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="align-top [&:not(:last-child)>td]:border-b [&:not(:last-child)>td]:border-fg/10">
              {row.map((cell, j) => (
                <td key={j} className={`px-4 py-3 ${j === 0 ? "font-medium text-fg" : "text-fg/70"}`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A note that must not be skimmed past. */
export function LegalCallout({ title, children, tone = "accent" }: { title: string; children: ReactNode; tone?: "accent" | "warn" }) {
  return (
    <aside className={`my-4 rounded-[16px] border px-4 py-3.5 ${tone === "warn" ? "border-warn/40 bg-warn/[0.07]" : "border-accent/35 bg-accent/[0.06]"}`}>
      <p className={`micro ${tone === "warn" ? "text-warn" : "text-accent"}`}>{title}</p>
      <div className="mt-1.5 text-[13.5px] leading-relaxed text-fg/80">{children}</div>
    </aside>
  );
}

/**
 * The shell for the two legal documents: a poster header with the document's facts, a plain-language summary, a
 * contents rail that follows the reader, and numbered sections that each open with one sentence of what they mean.
 * The sibling link is the other document, so neither ever dead-ends.
 */
export function LegalShell({
  label,
  title,
  standfirst,
  meta,
  glance,
  sections,
  sibling,
}: {
  label: string;
  title: string;
  standfirst: string;
  meta: LegalMeta;
  glance: LegalGlance[];
  sections: LegalSection[];
  sibling: { href: string; label: string };
}) {
  const { theme, setTheme } = useTheme();
  const ids = sections.map((s) => slug(s.heading));
  const [active, setActive] = useState(ids[0] ?? "");

  // The contents rail marks the section being read: the last heading that has scrolled past the top third.
  useEffect(() => {
    const onScroll = () => {
      const line = window.innerHeight * 0.32;
      let current = ids[0] ?? "";
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= line) current = id;
      }
      setActive(current);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [ids.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b border-fg/10 bg-[color-mix(in_oklab,var(--canvas)_82%,transparent)] backdrop-blur-md print:static print:border-0">
        <div className="mx-auto flex h-[64px] w-full max-w-[1180px] items-center justify-between gap-4 px-6 sm:px-8">
          <Link href="/" className="flex items-center gap-2.5" aria-label="Tessera home">
            <span className="tile flex size-9 items-center justify-center rounded-[11px]!">
              <Logo size={20} />
            </span>
            <span className="cond text-[19px]">Tessera</span>
            <span className="micro ml-2 hidden text-fg/45 sm:inline">Legal</span>
          </Link>
          <div className="flex items-center gap-5 print:hidden">
            <nav aria-label="Legal documents" className="micro hidden items-center gap-1 sm:flex">
              {[
                { href: "/terms", label: "Terms" },
                { href: "/privacy", label: "Privacy" },
              ].map((doc) => (
                <Link
                  key={doc.href}
                  href={doc.href}
                  aria-current={doc.label === label ? "page" : undefined}
                  className={`rounded-full px-3 py-1.5 transition-colors ${doc.label === label ? "bg-fg text-canvas" : "text-fg/60 hover:text-fg"}`}
                >
                  {doc.label}
                </Link>
              ))}
              <Link href="/" className="ml-2 px-2 text-fg/60 hover:text-fg">
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
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1180px] px-6 pb-16 sm:px-8">
        {/* ── The poster ── */}
        <section className="pt-14 sm:pt-20">
          <p className="kicker">Tessera · Legal · {label}</p>
          <div className="mt-4 flex flex-wrap items-end justify-between gap-x-10 gap-y-6">
            <div className="max-w-[760px]">
              <h1 className="cond text-[clamp(44px,7.4vw,92px)] leading-[0.92] tracking-[-0.01em]">
                {title}
                <span className="text-accent">.</span>
              </h1>
              <p className="mt-5 max-w-[62ch] text-[16px] leading-relaxed text-fg/70">{standfirst}</p>
            </div>
            <Barcode text={`TESSERA-${label.toUpperCase()}-${meta.version}`} className="hidden h-10 w-44 text-fg/50 md:block" />
          </div>

          <dl className="tile mt-9 grid grid-cols-2 overflow-hidden rounded-[22px]! md:grid-cols-4">
            {[
              ["Effective", meta.effective],
              ["Version", meta.version],
              ["Applies to", meta.appliesTo],
              ["Questions", "github.com/AXRoux/tessera"],
            ].map(([k, v], i) => (
              <div key={k} className={`px-5 py-4 ${i > 0 ? "md:border-l" : ""} ${i % 2 === 1 ? "border-l" : ""} ${i > 1 ? "border-t md:border-t-0" : ""} border-fg/10`}>
                <dt className="micro text-fg/50">{k}</dt>
                <dd className="mt-1.5 text-[13.5px] font-medium leading-snug">{v}</dd>
              </div>
            ))}
          </dl>
        </section>

        {/* ── At a glance ── */}
        <section aria-labelledby="glance" className="mt-14">
          <div className="flex items-baseline justify-between gap-4">
            <h2 id="glance" className="kicker">
              At a glance
            </h2>
            <p className="micro text-fg/45">Plain language. The numbered sections below govern.</p>
          </div>
          <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {glance.map((g, i) => (
              <li key={g.title} className="tile relative overflow-hidden rounded-[20px]! p-5">
                <span aria-hidden className="readout absolute right-5 top-4 text-[12px] leading-none text-fg/35">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span aria-hidden className="block h-[3px] w-8 bg-accent" />
                <p className="mt-3.5 text-[14.5px] font-semibold tracking-[-0.01em]">{g.title}</p>
                <p className="mt-1.5 text-[13px] leading-relaxed text-fg/65">{g.text}</p>
              </li>
            ))}
          </ul>
        </section>

        {/* ── The document ── */}
        <div className="mt-16 grid gap-10 lg:grid-cols-[230px_minmax(0,1fr)] lg:gap-14">
          <nav aria-label="Contents" className="hidden lg:block print:hidden">
            <div className="sticky top-[96px]">
              <p className="kicker">Contents</p>
              <ol className="mt-4 space-y-0.5 border-l border-fg/10">
                {sections.map((s, i) => {
                  const id = ids[i]!;
                  const on = id === active;
                  return (
                    <li key={id}>
                      <a
                        href={`#${id}`}
                        className={`-ml-px flex gap-3 border-l-2 py-1.5 pl-3.5 text-[12.5px] leading-snug transition-colors ${
                          on ? "border-accent font-medium text-fg" : "border-transparent text-fg/55 hover:text-fg"
                        }`}
                      >
                        <span className="readout w-5 shrink-0 text-fg/40">{String(i + 1).padStart(2, "0")}</span>
                        {s.heading}
                      </a>
                    </li>
                  );
                })}
              </ol>
              <button type="button" onClick={() => window.print()} className="micro mt-6 flex items-center gap-2 pl-4 text-fg/55 hover:text-fg">
                <Icon name="arrow" className="size-3 rotate-90" /> Print or save as PDF
              </button>
            </div>
          </nav>

          <ol className="min-w-0">
            {sections.map((s, i) => (
              <li key={ids[i]} id={ids[i]} className="scroll-mt-[96px] border-t border-fg/10 py-9 first:border-t-0 first:pt-0">
                <div className="flex items-baseline gap-4">
                  <span className="readout text-[13px] text-accent">{String(i + 1).padStart(2, "0")}</span>
                  <h2 className="cond text-[clamp(22px,2.4vw,28px)] leading-tight">{s.heading}</h2>
                </div>
                {s.summary ? (
                  <p className="mt-4 flex gap-3 rounded-[14px] bg-fg/[0.035] px-4 py-3 text-[13.5px] leading-relaxed text-fg/80">
                    <span className="micro shrink-0 pt-[3px] text-accent">In short</span>
                    <span>{s.summary}</span>
                  </p>
                ) : null}
                <div className={`mt-5 ${PROSE}`}>{s.body}</div>
              </li>
            ))}
          </ol>
        </div>

        <footer className="mt-12 grid gap-6 border-t border-fg/10 pt-8 md:grid-cols-[1fr_auto] md:items-end">
          <div>
            <p className="kicker">Tessera · Airwallex sandbox only · no real money</p>
            <p className="mt-2 max-w-[60ch] text-[12.5px] leading-relaxed text-fg/55">
              Tessera is an open-source project by Vance Poitier and NULL* Team, built for the Airwallex Agentic Banking Hackathon. It is not a bank, a payment institution or a card issuer.
            </p>
          </div>
          <div className="flex items-center gap-5 print:hidden">
            <Link href={sibling.href} className="tile flex h-10 items-center gap-2 rounded-full! px-4 text-[13px] font-medium">
              Read the {sibling.label} {sibling.label === "Terms" ? "of Service" : "Policy"}
              <Icon name="arrow" className="size-3.5" />
            </Link>
          </div>
        </footer>
      </main>
    </div>
  );
}
