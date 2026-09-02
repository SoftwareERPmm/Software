"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The actions for one row of a list, behind a dot menu.
 *
 * Three buttons per row is fine on a five-row table and ruinous on a real
 * catalogue: the actions column ends up wider than the names, and every
 * column that carries information gets squeezed to pay for it. Collapsing
 * them costs one click on the rare occasion someone deletes something, and
 * gives the width back to the data on every other row.
 *
 * Children are the menu items — ordinary buttons and forms, so each action
 * keeps working exactly as it did outside the menu.
 */
export function RowMenu({ label = "Actions", children }: {
  label?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // Closing on an outside click and on Escape, because a menu that can only
  // be dismissed by its own button is a menu people leave open by accident
  // and then click straight through on the row beneath.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div className="rowmenu" ref={box}>
      <button
        type="button"
        className="dots"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        &#8942;
      </button>
      {open && (
        // Any click inside is an action being taken, so the menu closes
        // behind it rather than lingering over the result.
        <div className="rowmenu-list" role="menu" onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}
