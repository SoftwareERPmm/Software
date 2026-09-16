"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, MoreHorizontal } from "lucide-react";

/**
 * The overflow menu at the top right of a document.
 *
 * What belongs in here: the things somebody does to a document occasionally,
 * and the one thing they must not do by accident. Correcting an order and
 * cancelling one are both rare and both consequential, and a cancel button
 * standing beside "Receive goods" gives an irreversible act the same weight
 * as the routine one. Two steps to reach it is the point, not a cost — and
 * the drawer that follows is a confirmation, not a second menu.
 *
 * Whatever is passed in keeps its own dialog; this only shows and hides the
 * list, and never unmounts it — the action clicked would otherwise be
 * destroyed by the same click. Their dialogs portal out to <body> (see
 * components/portal.tsx) so a hidden menu does not hide them too.
 */
export function ErpMore({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
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
    <div className="erp-more" ref={wrap}>
      <button
        type="button"
        className={`erp-hbtn${open ? " on" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal size={15} aria-hidden="true" />
        More
        <ChevronDown size={14} aria-hidden="true" />
      </button>

      {/* Hidden, never unmounted. Each action owns its own dialog and its own
          open state; unmounting the list would destroy the component that was
          just clicked, and the drawer with it. The dialogs portal out to
          <body>, so this being display:none does not reach them. */}
      <div className="erp-more-menu" role="menu" hidden={!open}
           onClick={() => setOpen(false)}>
        {children}
      </div>
    </div>
  );
}
