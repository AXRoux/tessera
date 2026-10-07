import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { Label } from "../ui";

const FIELD =
  "w-full border border-ink bg-paper px-4 text-sm placeholder:text-muted focus-visible:outline-2 focus-visible:outline-blue disabled:border-rule disabled:text-muted";

export function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="label mb-2 block">
        {label}
      </label>
      {children}
      {hint ? <p className="mt-2 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${FIELD} min-h-24 resize-y py-3 leading-relaxed ${props.className ?? ""}`} />;
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${FIELD} h-12 ${props.className ?? ""}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${FIELD} h-12 cursor-pointer ${props.className ?? ""}`} />;
}

/** A square check box: ink outline, blue fill with a white tick when set. */
export function Check({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-center gap-3 py-1.5 text-sm">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-5 shrink-0 cursor-pointer appearance-none border border-ink bg-paper checked:border-blue checked:bg-blue checked:bg-[url('data:image/svg+xml;utf8,<svg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%220%200%2020%2020%22><path%20d=%22M4%2010l4%204%208-9%22%20fill=%22none%22%20stroke=%22white%22%20stroke-width=%222.5%22/></svg>')]"
      />
      <span>{label}</span>
    </label>
  );
}

/** Result of an action, shown where the operator is looking. Refusals carry the reasons or blockers verbatim. */
export interface Notice {
  tone: "ok" | "refused";
  title: string;
  lines: string[];
}

export function NoticeBox({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  const refused = notice.tone === "refused";
  return (
    <div role={refused ? "alert" : "status"} className={`border px-5 py-4 ${refused ? "border-ink bg-ink text-paper" : "border-blue bg-wash"}`}>
      <Label className={refused ? "text-paper" : "text-blue"}>{notice.title}</Label>
      {notice.lines.length > 0 ? (
        <ul className="mt-3 space-y-2 text-sm leading-relaxed">
          {notice.lines.map((line, i) => (
            <li key={i} className="flex gap-3">
              <span aria-hidden className="mt-2 size-1.5 shrink-0 bg-current" />
              {line}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
