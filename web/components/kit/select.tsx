"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

export interface SelectOption {
  value: string;
  label: string;
  /** A short mono code set before the label in a small well, e.g. a merchant category code. */
  lead?: string;
  /** One quiet line under the label. */
  hint?: string;
  /** "bad": an option that is there to be refused (a charge the card should decline). */
  tone?: "bad";
}

interface Place {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
  down: boolean;
}

/** Space kept between the field and the list, and between the list and the window's edge. */
const GAP = 8;
const EDGE = 12;
const TYPEAHEAD_MS = 600;

const Chevron = ({ open }: { open: boolean }) => (
  <svg aria-hidden viewBox="0 0 24 24" className={`size-3.5 transition-transform duration-200 ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m6 9 6 6 6-6" />
  </svg>
);

const Tick = () => (
  <svg aria-hidden viewBox="0 0 12 12" className="size-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.5 6.5 5 9l4.5-5.5" />
  </svg>
);

/**
 * A select in the house style, in place of the browser's own: the field is a well like every other input, and the list
 * is a raised tile that opens below it (or above, when the window has no room), never clipped by the tray it sits in.
 *
 * It follows the ARIA select-only combobox pattern: focus stays on the field, arrows, Home, End and Page keys move
 * through the list, typing jumps to a match, Enter or Space picks, Escape closes (without closing the sheet around it),
 * Tab picks and moves on.
 */
export function Select({
  id,
  value,
  onChange,
  options,
  disabled = false,
  minListWidth = 240,
  className = "",
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  disabled?: boolean;
  /** The list may be wider than the field, so codes and hints are not cut short. */
  minListWidth?: number;
  className?: string;
}) {
  const listId = useId();
  const field = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const typed = useRef({ text: "", at: 0 });
  // Where the list is drawn: inside the themed shell (the theme is set there, not on <html>), as an inverted tile if the field is in one.
  const host = useRef<{ el: Element; inverse: boolean } | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<Place | null>(null);

  const chosen = Math.max(0, options.findIndex((o) => o.value === value));
  const current = options[chosen];

  const show = (at = chosen) => {
    const el = field.current;
    host.current = { el: el?.closest("[data-theme]") ?? document.body, inverse: el?.closest(".inverse") != null };
    setActive(at);
    setOpen(true);
  };
  const hide = () => {
    setOpen(false);
    setPlace(null);
  };
  const pick = (index: number) => {
    const option = options[index];
    if (option && option.value !== value) onChange(option.value);
    hide();
    field.current?.focus();
  };

  // Place the list against the field, below it unless the window has more room above, inside the window's edges.
  useLayoutEffect(() => {
    if (!open) return;
    const measure = (event?: Event) => {
      if (event?.target === list.current) return; // the list scrolling itself
      const el = field.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) return hide(); // scrolled out of sight
      const natural = list.current?.scrollHeight ?? 240;
      const below = window.innerHeight - r.bottom - GAP - EDGE;
      const above = r.top - GAP - EDGE;
      const down = below >= Math.min(natural, 280) || below >= above;
      const width = Math.min(Math.max(r.width, minListWidth), window.innerWidth - EDGE * 2);
      // A list wider than its field grows away from the nearer window edge.
      const fromRight = r.left + r.width / 2 > window.innerWidth / 2;
      const left = Math.min(Math.max(EDGE, fromRight ? r.right - width : r.left), window.innerWidth - EDGE - width);
      setPlace({
        left,
        width,
        maxHeight: Math.max(120, down ? below : above),
        ...(down ? { top: r.bottom + GAP } : { bottom: window.innerHeight - r.top + GAP }),
        down,
      });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, minListWidth]);

  // A press anywhere else only closes the list, as a native select's does: it does not also reach what is under it (the
  // sheet's backdrop would close the sheet, a button would fire).
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      const target = event.target as Node;
      if (field.current?.contains(target) || list.current?.contains(target)) return;
      event.preventDefault(); // no mousedown follows
      const swallow = (click: MouseEvent) => {
        click.preventDefault();
        click.stopPropagation();
      };
      document.addEventListener("click", swallow, { capture: true, once: true });
      document.addEventListener("pointerup", () => setTimeout(() => document.removeEventListener("click", swallow, true), 0), { capture: true, once: true });
      hide();
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open]);

  // Keep the highlighted option in view as the arrows move it.
  useEffect(() => {
    if (open && place) list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, place, active]);

  function typeahead(key: string): number | null {
    const now = Date.now();
    typed.current = { text: (now - typed.current.at < TYPEAHEAD_MS ? typed.current.text : "") + key.toLowerCase(), at: now };
    const text = typed.current.text;
    const start = open ? active : chosen;
    for (let step = text.length === 1 ? 1 : 0; step <= options.length; step++) {
      const index = (start + step) % options.length;
      const o = options[index]!;
      if (o.label.toLowerCase().startsWith(text) || (o.lead ?? "").toLowerCase().startsWith(text)) return index;
    }
    return null;
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const last = options.length - 1;
    const printable = event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey && event.key !== " ";
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        show();
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        show(event.key === "Home" ? 0 : last);
      } else if (printable) {
        const match = typeahead(event.key);
        if (match !== null) show(match);
      }
      return;
    }
    const move = (to: number) => {
      event.preventDefault();
      setActive(Math.min(last, Math.max(0, to)));
    };
    if (event.key === "ArrowDown") move(active + 1);
    else if (event.key === "ArrowUp" && event.altKey) {
      event.preventDefault();
      pick(active);
    } else if (event.key === "ArrowUp") move(active - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(last);
    else if (event.key === "PageDown") move(active + 8);
    else if (event.key === "PageUp") move(active - 8);
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      pick(active);
    } else if (event.key === "Escape") {
      // Close the list only: the sheet around it listens for Escape on the window.
      event.preventDefault();
      event.stopPropagation();
      hide();
    } else if (event.key === "Tab") {
      pick(active);
    } else if (printable) {
      const match = typeahead(event.key);
      if (match !== null) setActive(match);
    }
  }

  return (
    <>
      <button
        ref={field}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && place ? `${listId}-${active}` : undefined}
        disabled={disabled}
        // Keys open and pick in onKeyDown; a click a key synthesises (detail 0, e.g. Space's keyup) would undo it.
        onClick={(event) => {
          if (event.detail === 0) return;
          // Safari does not focus a button on click; the keys need focus here once the list is open.
          field.current?.focus({ preventScroll: true });
          if (open) hide();
          else show();
        }}
        onKeyDown={onKeyDown}
        onBlur={(event) => {
          if (open && !list.current?.contains(event.relatedTarget as Node | null)) hide();
        }}
        className={`well group flex h-10 w-full cursor-pointer items-center gap-2.5 rounded-[14px]! pl-3 pr-2 text-left text-[13px] text-fg outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-accent/45 disabled:cursor-not-allowed disabled:opacity-50 ${open ? "ring-2 ring-accent/35" : ""} ${className}`}
      >
        {current?.lead ? <span className={`readout shrink-0 text-[11.5px] ${current.tone === "bad" ? "text-bad" : "text-fg/50"}`}>{current.lead}</span> : null}
        <span className="min-w-0 flex-1 truncate">{current?.label ?? ""}</span>
        <span className={`flex size-6 shrink-0 items-center justify-center rounded-full transition-colors ${open ? "bg-accent text-white" : "text-fg/55 group-hover:text-fg"}`}>
          <Chevron open={open} />
        </span>
      </button>
      {open && host.current
        ? createPortal(
            <ul
              ref={list}
              id={listId}
              role="listbox"
              aria-labelledby={id}
              tabIndex={-1}
              // Keep focus on the field, so the keys keep working while the pointer picks.
              onMouseDown={(event) => event.preventDefault()}
              style={
                place
                  ? { left: place.left, width: place.width, maxHeight: place.maxHeight, top: place.top, bottom: place.bottom, transformOrigin: place.down ? "top" : "bottom" }
                  : { left: 0, top: 0, visibility: "hidden" }
              }
              className={`listbox thin-scroll fixed z-[80] flex flex-col gap-0.5 overflow-y-auto p-1.5 text-fg ${host.current.inverse ? "inverse" : ""} ${place ? (place.down ? "listbox-in" : "listbox-in-up") : ""}`}
            >
              {options.map((option, index) => {
                const isChosen = index === chosen;
                const isActive = index === active;
                return (
                  <li
                    key={option.value}
                    id={`${listId}-${index}`}
                    data-index={index}
                    role="option"
                    aria-selected={isChosen}
                    onPointerMove={() => index !== active && setActive(index)}
                    onClick={() => pick(index)}
                    className={`flex cursor-pointer items-center gap-3 rounded-[12px] px-2.5 py-2 transition-colors ${isActive ? "bg-fg/[0.07]" : ""}`}
                  >
                    {option.lead ? (
                      <span className={`well readout flex h-6 shrink-0 items-center rounded-[8px]! px-1.5 text-[11px] ${option.tone === "bad" ? "text-bad" : isChosen ? "text-accent" : "text-fg/60"}`}>{option.lead}</span>
                    ) : null}
                    <span className="min-w-0 flex-1">
                      <span className={`block text-[13px] leading-snug ${isChosen ? "font-medium text-fg" : "text-fg/85"}`}>{option.label}</span>
                      {option.hint ? <span className={`mt-0.5 block text-[11.5px] leading-snug ${option.tone === "bad" ? "text-bad/80" : "text-fg/45"}`}>{option.hint}</span> : null}
                    </span>
                    <span className={`flex size-5 shrink-0 items-center justify-center rounded-full ${isChosen ? "bg-accent text-white" : ""}`}>{isChosen ? <Tick /> : null}</span>
                  </li>
                );
              })}
            </ul>,
            host.current.el,
          )
        : null}
    </>
  );
}
