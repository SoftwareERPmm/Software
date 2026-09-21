"use client";

import { useState } from "react";
import Link from "next/link";
import {
  AlertTriangle, ArrowRight, ChevronRight, X, ShoppingCart, Package, Boxes,
} from "lucide-react";

export type AttentionItem = {
  n: number;
  /** Count-independent, so it reads the same at 1 as at 40. */
  label: string;
  detail?: string;
  href: string;
  tone: "bad" | "warn" | "info";
};

export type AttentionGroup = {
  key: string;
  title: string;
  sub: string;
  icon: "sales" | "purchases" | "inventory";
  items: AttentionItem[];
};

const ICONS = { sales: ShoppingCart, purchases: Package, inventory: Boxes };

/**
 * The counted exceptions, closed by default.
 *
 * Every figure here is a link to the thing it counted, which is the whole
 * point of counting them — but eleven of those laid out in a row is a
 * paragraph of small print above the figures the dashboard is actually for.
 * So the card states the total and opens on request, and once open it says
 * how to close again rather than repeating the invitation to open.
 */
export function AttentionPanel({
  total, groups,
}: {
  total: number;
  groups: AttentionGroup[];
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className={`attn${open ? " attn-open" : ""}`}>
      <div className="attn-head">
        <span className="attn-mark" aria-hidden="true"><AlertTriangle size={17} /></span>
        <div className="attn-headtext">
          <strong>
            {open
              ? "Needs attention"
              : `${total} thing${total === 1 ? "" : "s"} need${total === 1 ? "s" : ""} attention`}
          </strong>
          <span className="attn-sub">Open issues that may require your action</span>
        </div>

        {open ? (
          <>
            <span className="attn-pill">
              {total} open issue{total === 1 ? "" : "s"}
            </span>
            {/* The way out sits where the way in was. */}
            <button
              type="button"
              className="attn-btn attn-close"
              onClick={() => setOpen(false)}
              aria-label="Hide issues"
            >
              <X size={15} aria-hidden="true" />
            </button>
          </>
        ) : (
          <button type="button" className="attn-btn attn-more" onClick={() => setOpen(true)}>
            View all issues <ArrowRight size={14} aria-hidden="true" />
          </button>
        )}
      </div>

      {open && (
        <div className="attn-groups">
          {groups.map((g) => {
            const Icon = ICONS[g.icon];
            return (
              <section key={g.key} className="attn-group">
                <div className="attn-grouphead">
                  <Icon size={17} aria-hidden="true" />
                  <div>
                    <strong>{g.title}</strong>
                    <span className="attn-sub">{g.sub}</span>
                  </div>
                </div>
                <ul className="attn-list">
                  {g.items.map((it) => (
                    <li key={it.href + it.label}>
                      <Link href={it.href} className="attn-row">
                        <span className={`attn-n ${it.tone}`}>{it.n}</span>
                        <span className="attn-rowtext">
                          {it.label}
                          {it.detail && <span className="attn-detail">{it.detail}</span>}
                        </span>
                        <ChevronRight size={16} aria-hidden="true" className="attn-go" />
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
