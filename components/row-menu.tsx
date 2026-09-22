"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Portal } from "./portal";

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
 *
 * The list is portalled to <body> rather than positioned inside the row.
 * Every list here sits in .tablewrap, which is overflow-x: auto — and a box
 * that scrolls on one axis clips on both, so a menu opening from the last
 * row was cut off at the table's edge. Portalled and placed at the button's
 * own screen position, it escapes the wrapper entirely.
 */
export function RowMenu({ label = "Actions", children }: {
  label?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);

  /* Placed from the button's own rectangle each time it opens, and closed on
     scroll or resize rather than followed: a menu that drifts away from the
     row it belongs to is worse than one that shuts. */
  useEffect(() => {
    if (!open) { setAt(null); return; }
    const place = () => {
      const r = btn.current?.getBoundingClientRect();
      if (r) setAt({ top: r.bottom + 2, right: window.innerWidth - r.right });
    };
    place();
    const shut = () => setOpen(false);
    window.addEventListener("scroll", shut, true);
    window.addEventListener("resize", shut);
    return () => {
      window.removeEventListener("scroll", shut, true);
      window.removeEventListener("resize", shut);
    };
  }, [open]);

  // Closing on an outside click and on Escape, because a menu that can only
  // be dismissed by its own button is a menu people leave open by accident
  // and then click straight through on the row beneath.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      // The list is no longer a DOM child of this row, so "outside" has to
      // account for the portalled menu as well as the button.
      const inMenu = (t as HTMLElement)?.closest?.(".rowmenu-list");
      if (box.current && !box.current.contains(t) && !inMenu) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  /* A row near the bottom of the screen has no room beneath it, and a menu
     that opens off the edge of the window is a menu nobody can use.
     Measured when the node actually appears rather than on a render pass:
     the list is portalled, so it mounts a tick after the position is first
     worked out, and an effect watching that position would find nothing to
     measure. Its height depends on how many actions the row was given, so
     it is measured rather than assumed. */
  const measure = useCallback((node: HTMLDivElement | null) => {
    list.current = node;
    if (!node || !btn.current) return;
    const h = node.getBoundingClientRect().height;
    const r = btn.current.getBoundingClientRect();
    const below = r.bottom + 2;
    if (below + h > window.innerHeight - 8 && r.top - h > 8) {
      setAt({ top: r.top - h - 2, right: window.innerWidth - r.right });
    }
  }, []);

  return (
    <div className="rowmenu" ref={box}>
      <button
        ref={btn}
        type="button"
        className="dots"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        &#8942;
      </button>
      {open && at && (
        <Portal>
          {/* Any click inside is an action being taken, so the menu closes
              behind it rather than lingering over the result. */}
          <div
            ref={measure}
            className="rowmenu-list"
            role="menu"
            style={{ position: "fixed", top: at.top, right: at.right }}
            onClick={() => setOpen(false)}
          >
            {children}
          </div>
        </Portal>
      )}
    </div>
  );
}
