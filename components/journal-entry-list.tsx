"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { money } from "@/lib/format";

export type EntryLine = {
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
  memo: string | null;
  partnerName: string | null;
  locationCode: string | null;
};

export type Entry = {
  id: string;
  entryNo: string;
  entryDate: string;
  memo: string | null;
  documentId: string | null;
  docNo: string | null;
  docLabel: string;
  status: string | null;
  partnerName: string | null;
  debit: number;
  credit: number;
  lines: EntryLine[];
};

/**
 * The ledger read chronologically: every posted entry, with its own lines one
 * click away.
 *
 * Expanding in place rather than navigating is the point. The question this
 * screen answers — "what does this entry actually say" — is asked of one row
 * after another while scanning, and a round trip per row turns that into
 * twenty page loads. The document behind it is still a link, for when the
 * answer is "open the invoice".
 */
export function JournalEntryList({ entries }: { entries: Entry[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [all, setAll] = useState(false);

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const expandAll = () => {
    if (all) { setOpen(new Set()); setAll(false); }
    else { setOpen(new Set(entries.map((e) => e.id))); setAll(true); }
  };

  // Totals over everything listed. The server has already applied the
  // filters, so this is the total of what is on screen — which is what a
  // figure at the bottom of a filtered report has to mean.
  const totalDr = entries.reduce((s, e) => s + e.debit, 0);
  const totalCr = entries.reduce((s, e) => s + e.credit, 0);

  const exportCsv = () => {
    const rows: string[][] = [[
      "Entry", "Date", "Document", "Type", "Partner", "Account code",
      "Account", "Debit", "Credit", "Memo",
    ]];
    for (const e of entries) {
      for (const l of e.lines) {
        rows.push([
          e.entryNo, e.entryDate, e.docNo ?? "", e.docLabel, e.partnerName ?? "",
          l.accountCode, l.accountName, String(l.debit || ""), String(l.credit || ""),
          l.memo ?? e.memo ?? "",
        ]);
      }
    }
    const csv = rows
      .map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(","))
      .join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `journal-entries-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (entries.length === 0) {
    return <div className="empty">No posted entries match these filters.</div>;
  }

  return (
    <section>
      <div className="card">
        <div className="card-head">
          <h2>Journal entries</h2>
          <span className="actions">
            <span className="page-sub">
              {entries.length}{entries.length === 500 ? "+" : ""} entr
              {entries.length === 1 ? "y" : "ies"}
            </span>
            <button type="button" className="ghost tiny" onClick={expandAll}>
              {all ? "Collapse all" : "Expand all"}
            </button>
            <button type="button" className="ghost tiny" onClick={exportCsv}>Export</button>
            <button type="button" className="ghost tiny noprint"
                    onClick={() => window.print()}>Print</button>
          </span>
        </div>

        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: "2rem" }}><span className="sr-only">Expand</span></th>
                <th>Date</th>
                <th>Entry</th>
                <th>Document</th>
                <th>Description</th>
                <th className="r">Debit</th>
                <th className="r">Credit</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const isOpen = open.has(e.id);
                return (
                  <Fragment key={e.id}>
                    <tr>
                      <td>
                        <button type="button" className="ghost tiny expander"
                                aria-expanded={isOpen}
                                aria-label={isOpen ? "Hide lines" : "Show lines"}
                                onClick={() => toggle(e.id)}>
                          <span className="navcaret" data-open={isOpen}>›</span>
                        </button>
                      </td>
                      <td className="m">{e.entryDate}</td>
                      <td className="code">{e.entryNo}</td>
                      <td className="code">
                        {e.documentId
                          ? <Link href={`/documents/${e.documentId}`} style={{ color: "var(--brand)" }}>
                              {e.docNo ?? "—"}
                            </Link>
                          : "—"}
                      </td>
                      <td className="wrap">
                        {e.docLabel}
                        {e.partnerName && <span style={{ color: "var(--muted)" }}> · {e.partnerName}</span>}
                        {e.memo && <span style={{ color: "var(--muted)" }}> · {e.memo}</span>}
                      </td>
                      <td className="r">{money(e.debit)}</td>
                      <td className="r">{money(e.credit)}</td>
                      <td>
                        {e.status
                          ? <span className={`pill ${e.status.toLowerCase()}`}>{e.status}</span>
                          : <span className="pill">Posted</span>}
                      </td>
                    </tr>

                    {/* Rendered whether or not the row is open, and hidden
                        with the attribute. Two reasons: a printed ledger
                        should carry every line without someone expanding
                        eight rows first, and a collapsed entry's lines are
                        then still findable with the browser's own search. */}
                    {e.lines.map((l, i) => (
                      <tr key={`${e.id}-${i}`} className="entryline" hidden={!isOpen}>
                        <td />
                        <td />
                        <td className="code" style={{ color: "var(--muted)" }}>{l.accountCode}</td>
                        <td colSpan={2} className="wrap">
                          {/* Credits sit in from their debit, the way an entry
                              is written by hand — the shape carries the
                              meaning before any number is read. */}
                          <span style={{ paddingLeft: l.credit ? "1.25rem" : 0 }}>
                            {l.accountName}
                          </span>
                          {(l.memo || l.partnerName || l.locationCode) && (
                            <span style={{ color: "var(--muted)" }}>
                              {" · "}
                              {[l.partnerName, l.locationCode, l.memo].filter(Boolean).join(" · ")}
                            </span>
                          )}
                        </td>
                        <td className="r"><span className="dr">{l.debit ? money(l.debit) : ""}</span></td>
                        <td className="r"><span className="cr">{l.credit ? money(l.credit) : ""}</span></td>
                        <td />
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={5}>Total</td>
                <td className="r">{money(totalDr)}</td>
                <td className="r">{money(totalCr)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </section>
  );
}
