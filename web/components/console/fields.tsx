import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

/** Inputs are wells: recessed into the tile, so a field reads as a place to put something. */
const FIELD =
  "well w-full rounded-[14px]! px-3.5 text-[13px] text-fg placeholder:text-fg/35 outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-accent/45 disabled:opacity-50";

export function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-[12px] font-medium text-fg/70">
        {label}
      </label>
      {children}
      {hint ? <p className="mt-1.5 text-[11.5px] text-fg/45">{hint}</p> : null}
    </div>
  );
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${FIELD} min-h-20 resize-y py-2.5 leading-relaxed ${props.className ?? ""}`} />;
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${FIELD} h-10 ${props.className ?? ""}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${FIELD} h-10 cursor-pointer ${props.className ?? ""}`} />;
}

/** A round check: a recessed dot that fills blue. */
export function Check({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-center gap-3 py-1 text-[13px]">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="peer sr-only" />
      <span aria-hidden className="well flex size-[18px] shrink-0 items-center justify-center rounded-full! peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent/45">
        {checked ? (
          <svg viewBox="0 0 12 12" className="size-2.5 text-white" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2.5 6.5 5 9l4.5-5.5" />
          </svg>
        ) : null}
      </span>
      <span>{label}</span>
    </label>
  );
}

/** Result of an action, shown where the operator acted. Refusals carry the reasons or blockers verbatim. */
export interface Notice {
  tone: "ok" | "refused";
  title: string;
  lines: string[];
}

export function NoticeBox({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  const refused = notice.tone === "refused";
  return (
    <div role={refused ? "alert" : "status"} className="tile rounded-[20px]! px-4 py-3">
      <p className={`flex items-center gap-2 text-[12.5px] font-semibold ${refused ? "text-bad" : "text-accent"}`}>
        <span aria-hidden className={`size-2 rounded-full ${refused ? "bg-bad" : "bg-accent"}`} />
        {notice.title}
      </p>
      {notice.lines.length > 0 ? (
        <ul className="mt-1.5 space-y-1 pl-4 text-[12.5px] leading-relaxed text-fg/75">
          {notice.lines.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * A folded tile: one line that says what is inside, opening to the form. Keeps the long, rarely used forms from pushing
 * the decision off the screen. `open` sets only the first paint.
 */
export function Fold({ title, sub, open = false, children, tone = "plain" }: { title: ReactNode; sub?: ReactNode; open?: boolean; children: ReactNode; tone?: "plain" | "accent" }) {
  return (
    <details open={open} className={`tile group rounded-[20px]! ${tone === "accent" ? "ring-1 ring-accent/35" : ""}`}>
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 marker:hidden [&::-webkit-details-marker]:hidden">
        <span className={`size-2 shrink-0 rounded-full ${tone === "accent" ? "bg-accent" : "bg-fg/25"}`} />
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-semibold tracking-[-0.01em]">{title}</span>
          {sub ? <span className="mt-0.5 block text-[12px] leading-snug text-fg/50">{sub}</span> : null}
        </span>
        <span className="well flex size-7 shrink-0 items-center justify-center rounded-full!">
          <svg aria-hidden viewBox="0 0 24 24" className="size-3.5 text-fg/60 transition-transform group-open:rotate-180" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </summary>
      <div className="border-t border-fg/[0.07] px-4 pb-4 pt-3.5">{children}</div>
    </details>
  );
}
