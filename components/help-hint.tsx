"use client";

import { useEffect, useId, useRef, useState } from "react";
import { HelpCircle } from "lucide-react";

/**
 * The paragraph that explained a screen, folded into the mark that offers it.
 *
 * A statement is read for its figures, and three or four lines of prose above
 * them is read once and then sits there for good — occupying the space where
 * the numbers should start. The explanation is worth keeping and not worth
 * the room, which is what a hint is.
 *
 * Hover alone would hide it from anyone on a touch screen, so it answers a
 * click too, and focus opens it for the keyboard. Escape and any click
 * elsewhere close it.
 */
export function HelpHint({ label = "What this shows", children }: {
  /** Named for what it explains, since the mark itself says nothing. */
  label?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const id = useId();

  // A click elsewhere, or Escape, puts it away. Only while it is open —
  // otherwise every screen carrying a hint listens to every click on the page.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) { setOpen(false); setPinned(false); }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpen(false); setPinned(false); }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span
      className="helphint"
      ref={wrap}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => { if (!pinned) setOpen(false); }}
    >
      <button
        type="button"
        className="helphint-mark"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={() => { setPinned(!open || !pinned); setOpen(!open || !pinned); }}
        onFocus={() => setOpen(true)}
        onBlur={() => { if (!pinned) setOpen(false); }}
      >
        <HelpCircle size={14} aria-hidden="true" />
      </button>
      {open && (
        <span className="helphint-bubble" id={id} role="tooltip">
          {children}
        </span>
      )}
    </span>
  );
}
