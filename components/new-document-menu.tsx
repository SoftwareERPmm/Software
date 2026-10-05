"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";

/**
 * The dashboard's "New document" button, as a menu of the documents people
 * actually start their day entering.
 *
 * It used to link to /documents, which is a list and creates nothing — a
 * button promising a new document and delivering a table. Every entry here
 * goes to the create page that already exists for it, so this is a shortcut
 * and nothing more: the same form, the same rules, one click closer.
 *
 * Grouped the way the sidebar is, sales then purchases, each in the order a
 * document chain runs: order, goods, bill, money.
 */
const GROUPS: { label: string; items: [string, string][] }[] = [
  {
    label: "Sales",
    items: [
      ["Sales order", "/sales/orders/new"],
      ["Delivery", "/sales/deliver/new"],
      ["Sales invoice", "/sales/new"],
      ["Receive payment", "/receivables/receive"],
    ],
  },
  {
    label: "Purchases",
    items: [
      ["Purchase order", "/purchases/orders/new"],
      ["Goods receipt", "/purchases/receive/new"],
      ["Purchase invoice", "/purchases/new"],
      ["Pay supplier", "/payables/pay"],
    ],
  },
];

export function NewDocumentMenu() {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // Closed by a click anywhere else and by Escape — a menu that only its own
  // button can dismiss gets left open and clicked through.
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
    <div className="newdoc" ref={box}>
      <button
        type="button"
        className="dash-chip solid"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        New document <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="newdoc-list" role="menu" onClick={() => setOpen(false)}>
          {GROUPS.map((g) => (
            <div key={g.label} className="newdoc-group" role="group" aria-label={g.label}>
              <span className="newdoc-label">{g.label}</span>
              {g.items.map(([label, href]) => (
                <Link key={href} href={href} role="menuitem">{label}</Link>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
