"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useState } from "react";
import { setSidebarCollapsed, useSidebarCollapsed } from "@/components/sidebar-collapse";

export function NavLink({
  href,
  exact,
  sub,
  clearParams,
  children,
}: {
  href: string;
  /** Match this path only, not everything beneath it. */
  exact?: boolean;
  /** Indented one level, for an entry that narrows the one above it. */
  sub?: boolean;
  /**
   * Query keys that, when present, mean this unfiltered link should not be
   * lit — because a sibling NavLink filters the same page by that key. Set
   * this on the "reset" entry (e.g. plain "Partners" above "Customers" and
   * "Suppliers"); the filtered siblings match on their own query already.
   */
  clearParams?: string[];
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const params = useSearchParams();

  const [path, query] = href.split("?");

  // A link carrying a query is a filtered view of its own page, so the query
  // has to match too — otherwise Partners, Customers and Suppliers all light
  // up at once, and none of them tells you where you are.
  const pathMatches = path === "/" || exact || sub ? pathname === path : pathname.startsWith(path);

  let active = pathMatches;
  if (pathMatches) {
    const wanted = new URLSearchParams(query ?? "");
    if (query) {
      for (const [k, v] of wanted) {
        if (params.get(k) !== v) active = false;
      }
    } else if (clearParams?.some((k) => params.get(k))) {
      // A filter from clearParams is set, so the unfiltered "reset" entry
      // yields to whichever sibling actually matches it.
      active = false;
    }
  }

  return (
    <Link href={href} className="navlink" data-active={active} data-sub={sub || undefined}>
      {children}
    </Link>
  );
}

/**
 * A collapsible group. Opens itself when the current page is inside it, so
 * you always see where you are without every section being expanded at once.
 */
export function NavGroup({
  label,
  icon,
  match,
  children,
  defaultOpen,
}: {
  label: string;
  /** A small section icon — lucide components work as-is (currentColor stroke). */
  icon?: React.ReactNode;
  /** Path prefixes that belong to this group. */
  match: string[];
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const pathname = usePathname();
  const contains = match.some((m) => (m === "/" ? pathname === "/" : pathname.startsWith(m)));
  const [open, setOpen] = useState<boolean | null>(null);
  const collapsed = useSidebarCollapsed();

  const isOpen = open ?? (contains || Boolean(defaultOpen));

  return (
    <div className="navgroup">
      <button
        type="button"
        className="navhead"
        /* Collapsed, the list this would open is not on screen, so toggling it
           is a click that does nothing visible. It opens the rail instead and
           shows the group — which is what somebody clicking an icon on a rail
           of icons is asking for. */
        onClick={() => {
          if (collapsed) {
            setSidebarCollapsed(false);
            setOpen(true);
            return;
          }
          setOpen(!isOpen);
        }}
        aria-expanded={isOpen}
        data-inside={contains}
        /* The icon is the whole label on a rail. Only then is a tooltip worth
           having; beside the word itself it is noise. */
        title={collapsed ? label : undefined}
      >
        <span className="navhead-label">
          {icon}
          <span className="navhead-text">{label}</span>
        </span>
        <span className="navcaret" data-open={isOpen}>›</span>
      </button>
      {/* Rendered always, visibility toggled by CSS via data-open — not
          conditionally unmounted. A collapsed group with unmounted children
          has no click target left on narrow screens, where the toggle
          button itself is hidden by the mobile layout: there would be no
          way back into it. CSS-driven visibility keeps the links reachable
          there while still collapsing on desktop. */}
      <div className="navitems" data-open={isOpen}>{children}</div>
    </div>
  );
}

/**
 * A second collapse level, nested inside a NavGroup — e.g. "Transactions"
 * and "Ledgers" inside "Accounting". Same open/auto-open/CSS-visibility
 * behaviour as NavGroup, styled one step smaller and further indented so it
 * reads as "part of" the group above it rather than a sibling section.
 */
export function NavSubGroup({
  label,
  match,
  children,
  defaultOpen,
}: {
  label: string;
  /** Path prefixes that belong to this sub-group. */
  match: string[];
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const pathname = usePathname();
  const contains = match.some((m) => pathname.startsWith(m));
  const [open, setOpen] = useState<boolean | null>(null);

  const isOpen = open ?? (contains || Boolean(defaultOpen));

  return (
    <div className="navsubgroup">
      <button
        type="button"
        className="navsubhead"
        onClick={() => setOpen(!isOpen)}
        aria-expanded={isOpen}
        data-inside={contains}
      >
        <span>{label}</span>
        <span className="navcaret" data-open={isOpen}>›</span>
      </button>
      <div className="navsubitems" data-open={isOpen}>{children}</div>
    </div>
  );
}
