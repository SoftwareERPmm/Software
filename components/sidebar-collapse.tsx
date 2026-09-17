"use client";

import { useEffect, useState } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

/**
 * The sidebar as a rail of icons.
 *
 * Nine groups and sixty links is a lot of left-hand column to carry on every
 * page, and most of the time you are reading the page rather than looking for
 * the next one. Collapsed, the rail keeps the one thing worth keeping — which
 * section you are in — and gives the width back to the figures.
 *
 * Kept on <body>, like the mobile drawer above it, so the sidebar stays where
 * it is in the layout and the collapse is entirely a matter of CSS. Nothing
 * unmounts: every link is still in the DOM, still reachable, still the same
 * nav. And kept in localStorage, because a preference about how you want to
 * work is not something to re-state on every page load.
 */

const KEY = "navCollapsed";
const EVENT = "sidebar-collapse-change";

export function setSidebarCollapsed(next: boolean) {
  document.body.dataset.navCollapsed = next ? "true" : "false";
  try {
    localStorage.setItem(KEY, String(next));
  } catch {
    // Private browsing, or storage refused. The rail still collapses; it just
    // forgets by the next page.
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
}

/**
 * Whether the rail is collapsed right now, for the parts of the nav that have
 * to behave differently there rather than merely look different.
 *
 * Starts false on both server and first client render — reading <body> during
 * render would disagree with the HTML React is hydrating against. The effect
 * below corrects it immediately after, which is early enough: what depends on
 * this is a tooltip and a click handler, not layout.
 */
export function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setCollapsed(document.body.dataset.navCollapsed === "true");
    const onChange = (e: Event) => setCollapsed((e as CustomEvent<boolean>).detail);
    window.addEventListener(EVENT, onChange);
    return () => window.removeEventListener(EVENT, onChange);
  }, []);

  return collapsed;
}

export function SidebarCollapse() {
  const collapsed = useSidebarCollapsed();

  return (
    <div className="navcollapse-row">
      <button
        type="button"
        className="navcollapse"
        aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
        aria-expanded={!collapsed}
        aria-controls="sidebar"
        title={collapsed ? "Expand navigation" : "Collapse navigation"}
        onClick={() => setSidebarCollapsed(!collapsed)}
      >
        {collapsed
          ? <PanelLeftOpen size={16} aria-hidden="true" />
          : <PanelLeftClose size={16} aria-hidden="true" />}
      </button>
    </div>
  );
}
