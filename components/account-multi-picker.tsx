"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { groupAccountsBySection } from "@/lib/format";
import { ACCOUNT_TYPE_LABEL } from "./account-form";
import { ChevronDown } from "lucide-react";

type Option = {
  id: string; code: string; name: string;
  parent_id?: string | null; account_type?: string;
};
type TreeNode = {
  id: string; code: string; name: string; parent_id: string | null; is_postable?: boolean;
};

/**
 * Which accounts a ledger is showing — several at once, ticked in the list.
 *
 * A plain select answers "which one", and the question here is often "which
 * of these": cash is four accounts, and reading them one at a time to add up
 * by hand is the work the page is meant to do.
 *
 * Ticking does not navigate. A round trip per tick makes choosing four
 * accounts four page loads, three of which show a set nobody asked for — so
 * the ticks are local and Apply sends them, once.
 */
export function AccountMultiPicker({
  accounts, tree = [], selectedIds, basePath, keep, label = "Accounts",
}: {
  accounts: Option[];
  tree?: TreeNode[];
  selectedIds: string[];
  basePath: string;
  keep?: Record<string, string | undefined>;
  label?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>(selectedIds);
  const [q, setQ] = useState("");
  const box = useRef<HTMLDivElement>(null);

  // What the page is actually showing wins: arriving by link, or going back,
  // must not leave the ticks describing some earlier selection.
  useEffect(() => { setPicked(selectedIds); }, [selectedIds.join(",")]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const groups = useMemo(
    () => (tree.length ? groupAccountsBySection(accounts, tree, ACCOUNT_TYPE_LABEL) : null),
    [accounts, tree],
  );

  const term = q.trim().toLowerCase();
  const hit = (a: Option) =>
    !term || `${a.code} ${a.name}`.toLowerCase().includes(term);

  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const apply = (ids: string[]) => {
    setOpen(false);
    const params = new URLSearchParams({ account: ids.join(",") });
    for (const [k, v] of Object.entries(keep ?? {})) if (v) params.set(k, v);
    router.push(`${basePath}?${params.toString()}`);
  };

  const chosen = accounts.filter((a) => picked.includes(a.id));
  const summary =
    chosen.length === 0 ? "Choose accounts"
    : chosen.length === 1 ? `${chosen[0].code} · ${chosen[0].name}`
    : `${chosen.length} accounts`;
  const changed = picked.join(",") !== selectedIds.join(",");

  const row = (a: Option) => (
    <label key={a.id} className="tickrow">
      <input type="checkbox" checked={picked.includes(a.id)} onChange={() => toggle(a.id)} />
      <span className="m">{a.code}</span>
      <span className="tickname">{a.name}</span>
    </label>
  );

  return (
    <div className={`field tickfield${open ? " open" : ""}`} ref={box}
         style={{ maxWidth: 420 }}>
      <label htmlFor="acctmulti">{label}</label>
      <button id="acctmulti" type="button" className="tickbutton"
              aria-expanded={open} aria-haspopup="listbox"
              onClick={() => setOpen((o) => !o)}>
        <span className="tickbutton-text">{summary}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>

      {open && (
        <div className="tickpanel" role="listbox" aria-multiselectable="true">
          <input className="ticksearch" type="search" value={q} autoFocus
                 placeholder="Search accounts…" aria-label="Search accounts"
                 onChange={(e) => setQ(e.target.value)} />

          <div className="ticklist">
            {groups
              ? groups.map(([heading, items]) => {
                  const shown = items.filter(hit);
                  if (shown.length === 0) return null;
                  return (
                    <div key={heading}>
                      {/* The section, as a label only. Ticking is per account:
                          a heading has no lines of its own, and offering it
                          as a single choice hid which accounts were actually
                          being read. */}
                      <div className="tickhead">{heading}</div>
                      {shown.map(row)}
                    </div>
                  );
                })
              : accounts.filter(hit).map(row)}
            {accounts.filter(hit).length === 0 && (
              <div className="empty">Nothing matches &ldquo;{q}&rdquo;.</div>
            )}
          </div>

          <div className="tickfoot">
            <button type="button" disabled={picked.length === 0 || !changed}
                    onClick={() => apply(picked)}>
              {picked.length <= 1 ? "Show account" : `Show ${picked.length} accounts`}
            </button>
            <button type="button" className="ghost tiny"
                    onClick={() => setPicked([])}>Clear</button>
          </div>
        </div>
      )}
    </div>
  );
}
