"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";

/**
 * The sidebar as a drawer, on a screen too narrow to keep it open.
 *
 * The nav carries about sixty links under nine groups. Laid out as a
 * horizontal scrolling strip — which is what the stylesheet used to attempt —
 * that is a row you swipe through looking for a word, with the group headings
 * hidden because they have nowhere to go. A drawer keeps the structure it
 * already has: same groups, same order, same collapsing, just off-canvas
 * until it is asked for.
 *
 * State lives on <body> rather than in a wrapper, so the sidebar stays where
 * it is in the layout and nothing about the desktop tree changes. The bar and
 * the scrim are the only new elements, and both are display:none above the
 * breakpoint.
 */
export function MobileNav({ title, subtitle }: { title: string; subtitle: string }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close on navigation. Tapping a link in an open drawer should land on the
  // page, not leave the drawer sitting over it.
  useEffect(() => { setOpen(false); }, [pathname]);

  useEffect(() => {
    document.body.dataset.navOpen = open ? "true" : "false";
    // The page behind a drawer must not scroll with it, or closing the drawer
    // returns you somewhere other than where you left.
    document.body.style.overflow = open ? "hidden" : "";
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Left behind on unmount the page would be unscrollable for good.
  useEffect(() => () => {
    document.body.dataset.navOpen = "false";
    document.body.style.overflow = "";
  }, []);

  return (
    <>
      <header className="navbar">
        <button
          type="button"
          className="navbar-toggle"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          aria-controls="sidebar"
          onClick={() => setOpen(!open)}
        >
          {open ? <X size={18} aria-hidden="true" /> : <Menu size={18} aria-hidden="true" />}
        </button>
        <span className="navbar-title">
          <span className="navbar-name">{title}</span>
          <span className="navbar-sub">{subtitle}</span>
        </span>
      </header>
      {/* Not hidden when closed — it carries the fade, and a display swap
          cannot transition. Pointer events are what make it inert. */}
      <div className="navscrim" onClick={() => setOpen(false)} aria-hidden="true" />
    </>
  );
}
