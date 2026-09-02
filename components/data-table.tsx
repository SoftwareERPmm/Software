"use client";

import { Fragment, useMemo, useState } from "react";

export type Column = {
  key: string;
  label: string;
  sortable?: boolean;
  align?: "r";
};

export type DataRow = {
  key: string;
  /** Combined lowercase-searchable text for this row. */
  searchText: string;
  /** Sort value per sortable column key. */
  sort?: Record<string, string | number>;
  /** This row as flat cells, for Export. Plain data rather than a formatter
   *  callback, for the same serialization reason `node` is pre-rendered. */
  csv?: (string | number | null)[];
  /** The row already rendered as a <tr> — a Server Component page renders
   *  its own markup exactly as before; this component never touches it. */
  node: React.ReactNode;
};

/**
 * Search and sort for an already-fetched list, entirely client-side — these
 * pages are small master-data/document lists, not paged reports, so there's
 * nothing worth a server round trip for.
 *
 * Rows arrive pre-rendered (DataRow.node) with plain searchText/sort data
 * alongside, rather than as callbacks — a Server Component page can hand a
 * Client Component already-rendered JSX and plain data, but not a function;
 * React has no way to serialize a closure across that boundary (only a
 * "use server" action gets special handling), so renderRow/getSearchText/
 * getSortValue callbacks would crash in production even though they type-
 * check fine locally with no DATABASE_URL to actually exercise the render.
 */
export function DataTable({
  rows,
  columns,
  searchPlaceholder = "Search…",
  defaultSort,
  emptyLabel = "Nothing here",
  footer,
  csvHeader,
  csvFilename,
}: {
  rows: DataRow[];
  columns: Column[];
  searchPlaceholder?: string;
  defaultSort?: { key: string; dir: "asc" | "desc" };
  emptyLabel?: string;
  /** Column titles for the exported file. Export appears only when this and
   *  csvFilename are both given and the rows carry `csv`. */
  csvHeader?: string[];
  csvFilename?: string;
  /** Rendered as <tfoot>, on the unfiltered/unsorted totals — a search that hides rows shouldn't change a grand total. */
  footer?: React.ReactNode;
}) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(defaultSort ?? null);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? rows.filter((r) => r.searchText.toLowerCase().includes(needle)) : rows;
  }, [rows, q]);

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const copy = [...filtered];
    copy.sort((a, b) => {
      const av = a.sort?.[sort.key] ?? "";
      const bv = b.sort?.[sort.key] ?? "";
      const cmp =
        typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return sort.dir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [filtered, sort]);

  /**
   * Exports what is on screen — search applied, in the order displayed —
   * rather than the rows the page started with. A file that disagrees with
   * the table above it is worse than no export at all, because the difference
   * is invisible until someone acts on the wrong list.
   */
  function exportCsv() {
    const quote = (v: string | number | null) => {
      const t = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const lines = [
      (csvHeader ?? []).map(quote).join(","),
      ...sorted.map((r) => (r.csv ?? []).map(quote).join(",")),
    ];
    // A BOM, so Excel opens Burmese names as UTF-8 instead of mojibake.
    const blob = new Blob(["\ufeff" + lines.join("\n") + "\n"], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = csvFilename ?? "export.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const canExport = Boolean(csvHeader && csvFilename && rows.some((r) => r.csv));

  function toggleSort(key: string) {
    setSort((s) => {
      if (!s || s.key !== key) return { key, dir: "asc" };
      if (s.dir === "asc") return { key, dir: "desc" };
      return null;
    });
  }

  return (
    <>
      <div style={{ marginBottom: "0.75rem", display: "flex", gap: "0.5rem", alignItems: "center" }}>
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={searchPlaceholder}
          aria-label="Search"
          style={{ maxWidth: 320 }}
        />
        {canExport && (
          <button type="button" className="ghost" onClick={exportCsv} disabled={sorted.length === 0}>
            Export {sorted.length !== rows.length ? `${sorted.length} of ${rows.length}` : ""}
          </button>
        )}
      </div>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} className={c.align === "r" ? "r" : undefined}>
                  {c.sortable ? (
                    <button type="button" className="sortbtn" onClick={() => toggleSort(c.key)}>
                      {c.label}
                      {sort?.key === c.key ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <Fragment key={r.key}>{r.node}</Fragment>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="empty">
                  {q ? "No matches" : emptyLabel}
                </td>
              </tr>
            )}
          </tbody>
          {footer && <tfoot>{footer}</tfoot>}
        </table>
      </div>
    </>
  );
}
