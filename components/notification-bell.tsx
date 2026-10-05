"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell, BellOff } from "lucide-react";
import { Portal } from "./portal";
import {
  getNotifications, getUnreadCount, markNotificationsSeen, setNotificationsOn,
  type NotificationItem, type NotificationState,
} from "@/lib/notification-actions";

const POLL_MS = 60_000;
const PANEL_W = 420;

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

const money = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * One event: what happened to which document, then who did it and what it
 * was about. The badge is the person's initials; their name is spelled out
 * on the line beneath, so the letter is never the only clue.
 */
function Line({ n }: { n: NotificationItem }) {
  return (
    <Link href={`/documents/${n.documentId}`} className="notif-item" data-unread={n.unread} role="menuitem">
      <span className="notif-mark" aria-hidden="true" title={n.actor}>{n.initials}</span>
      <span className="notif-body">
        <span className="notif-text">
          {cap(n.docLabel)}{" "}
          <span className={n.kind === "voided" ? "notif-verb bad" : "notif-verb"}>{n.kind}</span>
        </span>
        <span className="notif-no">{n.docNo}</span>
        <span className="notif-meta">
          {[
            `by ${n.actor}`,
            n.partner,
            n.amount !== null ? `${n.currency}\u00a0${money(n.amount)}` : null,
            n.reason ? `“${n.reason}”` : null,
          ].filter(Boolean).join(" · ")}
        </span>
      </span>
      <span className="notif-when">{ago(n.at)}</span>
    </Link>
  );
}

/**
 * Who did what, for the people who need to know.
 *
 * Two forms of the same control. In the rail it is a row above the account,
 * opening a panel beside the rail that points back at it. On a phone it is a
 * bell in the top bar, opening a panel beneath. Admin and Manager start with
 * it on, everyone else off; the switch is in the panel's footer. Opening the
 * panel marks what is in it as read. The count polls once a minute, and only
 * for the copy actually on screen.
 */
export function NotificationBell({
  initial, variant = "rail",
}: {
  initial: { on: boolean; unread: number };
  variant?: "rail" | "bar";
}) {
  const [on, setOn] = useState(initial.on);
  const [unread, setUnread] = useState(initial.unread);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<NotificationState | null>(null);
  const [busy, setBusy] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<React.CSSProperties | null>(null);

  useEffect(() => {
    if (!on) return;
    const tick = async () => {
      if (document.hidden || !btn.current?.offsetParent) return;
      try { setUnread((await getUnreadCount()).unread); } catch { /* next tick */ }
    };
    const id = window.setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => { window.clearInterval(id); document.removeEventListener("visibilitychange", tick); };
  }, [on]);

  /* Beside the rail, bottom-aligned with the row and pointing at it; or, on
     a phone, under the bar, kept inside the screen. */
  const place = useCallback(() => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    if (variant === "rail") {
      const rail = document.getElementById("sidebar")?.getBoundingClientRect();
      const left = (rail?.right ?? r.right) + 12;
      const bottom = Math.max(12, window.innerHeight - r.bottom - 8);
      const tail = window.innerHeight - bottom - (r.top + r.height / 2);
      setPos({ position: "fixed", left, bottom, width: PANEL_W,
               ["--tail" as string]: `${Math.max(16, tail - 7)}px` });
    } else {
      const width = Math.min(PANEL_W, window.innerWidth - 16);
      setPos({ position: "fixed", top: r.bottom + 8, left: Math.max(8, window.innerWidth - width - 8), width });
    }
  }, [variant]);

  const openPanel = async () => {
    place();
    setOpen(true);
    setBusy(true);
    try {
      const s = await getNotifications();
      setState(s);
      setOn(s.on);
      // Read the moment they are on screen; the server catches up behind.
      if (s.on && s.unread > 0) { setUnread(0); void markNotificationsSeen(); }
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest?.(".notif-panel") && !btn.current?.contains(t)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); btn.current?.focus(); } };
    const shut = () => setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    window.addEventListener("resize", shut);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
      window.removeEventListener("resize", shut);
    };
  }, [open]);

  const toggle = async () => {
    setBusy(true);
    try {
      const s = await setNotificationsOn(!on);
      setOn(s.on); setState(s); setUnread(0);
    } finally {
      setBusy(false);
    }
  };

  const label = !on ? "Notifications are off" : unread > 0 ? `${unread} unread notifications` : "Notifications";
  const count = unread > 99 ? "99+" : String(unread);

  return (
    <>
      <button
        ref={btn} type="button" className={`notif-trigger notif-${variant}`} data-off={!on}
        aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openPanel())}
      >
        <span className="notif-icon">
          {on ? <Bell size={variant === "rail" ? 17 : 16} aria-hidden="true" />
              : <BellOff size={variant === "rail" ? 17 : 16} aria-hidden="true" />}
          {on && unread > 0 && <span className="notif-dot" aria-hidden="true" />}
        </span>
        {variant === "rail" && <span className="notif-label">Notifications</span>}
        {on && unread > 0 && <span className="notif-count">{count}</span>}
      </button>
      {open && pos && (
        <Portal>
          <div className={`notif-panel from-${variant}`} role="menu" aria-label="Notifications" style={pos}>
            <div className="notif-head">
              <span className="notif-title">Notifications</span>
              <Link href="/documents" className="notif-all" onClick={() => setOpen(false)}>View all</Link>
            </div>
            <div className="notif-list">
              {!on ? (
                <p className="notif-empty">
                  Notifications are off. Turn them on below to see what others
                  post and void in the parts of the system you can reach.
                </p>
              ) : busy && !state ? (
                <p className="notif-empty">Loading…</p>
              ) : state && state.items.length === 0 ? (
                <p className="notif-empty">Nothing yet. Documents others post will show up here.</p>
              ) : (
                state?.items.map((n) => <Line key={n.id} n={n} />)
              )}
            </div>
            <label className="notif-foot">
              <span>Notify me about others&rsquo; documents</span>
              <span className="notif-switch">
                <input type="checkbox" role="switch" checked={on} disabled={busy} onChange={toggle} />
                <span className="notif-track" aria-hidden="true"><span /></span>
              </span>
            </label>
          </div>
        </Portal>
      )}
    </>
  );
}
