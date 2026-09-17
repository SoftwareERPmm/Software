"use client";

import { Fragment, useEffect, useId, useMemo, useState } from "react";
import { Columns3, ChevronLeft, ChevronRight } from "lucide-react";

export type Column = {
  key: string;
  label: string;
  sortable?: boolean;
  align?: "r";
};

/** One dropdown above the table: pick a value and only rows carrying it stay. */
export type Filter = {
  key: string;
  /** What the "everything" option says — "All warehouses", "All statuses". */
  allLabel: string;
  options: { value: string; label: string }[];
};

/** A field that exists only in the export — never on screen, never hideable. */
export type CsvExtra = { key: string; label: string };

export type DataRow = {
  key: string;
  /** Combined lowercase-searchable text for this row. */
  searchText: string;
  /** Value per filter key, matched against the dropdown selection. */
  facet?: Record<string, string>;
  /** Sort value per sortable column key. */
  sort?: Record<string, string | number>;
  /**
   * This row's exportable values, keyed by column key — not a positional
   * array. Keyed, because the export follows the columns that are on screen,
   * and a hidden column has to be able to drop out of the file without every
   * value after it shifting one place left. Keys with no matching column are
   * export-only fields; declare them in `csvExtra` to give them a heading.
   */
  csv?: Record<string, string | number | null>;
  /** The row already rendered as a <tr> — a Server Component page renders
   *  its own markup exactly as before; this component never touches it. */
  node: React.ReactNode;
};

const PAGE_SIZES = [10, 20, 50, 100];

/**
 * Search, sort, choose columns and page for an already-fetched list, entirely
 * client-side — these pages are small master-data/document lists, not paged
 * reports, so there's nothing worth a server round trip for.
 *
 * Rows arrive pre-rendered (DataRow.node) with plain searchText/sort data
 * alongside, rather than as callbacks — a Server Component page can hand a
 * Client Component already-rendered JSX and plain data, but not a function;
 * React has no way to serialize a closure across that boundary (only a
 * "use server" action gets special handling), so renderRow/getSearchText/
 * getSortValue callbacks would crash in production even though they type-
 * check fine locally with no DATABASE_URL to actually exercise the render.
 *
 * That same opacity is why hiding a column is done in CSS rather than by not
 * rendering a cell: this component owns the headings and knows nothing about
 * what is inside a row, so it hides the nth cell of every row instead of
 * dropping one. A generated rule, scoped to this table alone.
 */
export function DataTable({
  rows,
  columns,
  searchPlaceholder = "Search…",
  defaultSort,
  emptyLabel = "Nothing here",
  footer,
  footerCells,
  csvHeader,
  csvFilename,
  csvExtra = [],
  filters = [],
  tableClassName,
  storageKey,
  defaultPageSize = 10,
}: {
  rows: DataRow[];
  columns: Column[];
  searchPlaceholder?: string;
  /** Narrowing by a column's value, beside the search box. A filter whose
   *  options are all one value is not offered — a dropdown with nothing to
   *  choose is furniture. */
  filters?: Filter[];
  defaultSort?: { key: string; dir: "asc" | "desc" };
  emptyLabel?: string;
  /** Unused now the header comes from the column labels; kept so a caller
   *  passing it is not silently ignored. */
  csvHeader?: string[];
  csvFilename?: string;
  /** Export-only fields, appended after the visible columns. */
  csvExtra?: CsvExtra[];
  /**
   * Rendered as <tfoot>, on the unfiltered/unsorted totals — a search that
   * hides rows shouldn't change a grand total. A table using this cannot also
   * offer a column picker: the row's colSpans are written for every column,
   * and JSX handed over from a Server Component arrives here as something
   * React will render but `isValidElement` rejects — so it cannot be measured
   * or re-spanned once a column goes. Use `footerCells` for a table that
   * should have the picker.
   */
  footer?: React.ReactNode;
  /**
   * The same totals row, as data rather than markup: one spanning cell on the
   * left, then a value under whichever columns carry one. Said this way the
   * row is rebuilt from whatever is visible, so hiding a column moves the
   * total with it instead of leaving it a column adrift.
   */
  footerCells?: { span: React.ReactNode; cells: Record<string, React.ReactNode> };
  /** For a table whose rows are not all the same kind — one whose rows expand,
   *  say, where the zebra striping has to be turned off because the extra
   *  <tr> shifts every stripe below it. */
  tableClassName?: string;
  /** Where this table's column choices are remembered. Without one they last
   *  until the page reloads, which is the right default for a table nobody
   *  has said belongs to a particular screen. */
  storageKey?: string;
  defaultPageSize?: number;
}) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(defaultSort ?? null);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [hidden, setHidden] = useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(defaultPageSize);

  // A column with no heading is a control — the expand chevron, the row menu,
  // a thumbnail. There is nothing to name it by in a menu, and hiding it
  // would take a row's actions away.
  const canHideColumns = !footer || Boolean(footerCells);
  const hideable = useMemo(
    () => (canHideColumns ? columns.filter((c) => c.label.trim() !== "") : []),
    [columns, canHideColumns]);

  const rawId = useId();
  const scope = `dt-${rawId.replace(/[^a-zA-Z0-9]/g, "")}`;

  // Read after mount, not during render: the server has no localStorage, and
  // a first render that disagreed with the HTML it hydrates is a mismatch.
  useEffect(() => {
    if (!storageKey) return;
    try {
      const saved = localStorage.getItem(`cols:${storageKey}`);
      if (saved) setHidden(JSON.parse(saved) as string[]);
    } catch {
      // Storage refused, or the value is no longer JSON. Every column shows,
      // which is the state this started in.
    }
  }, [storageKey]);

  function toggleColumn(key: string) {
    setHidden((h) => {
      const next = h.includes(key) ? h.filter((k) => k !== key) : [...h, key];
      if (storageKey) {
        try {
          localStorage.setItem(`cols:${storageKey}`, JSON.stringify(next));
        } catch {
          // The choice still applies; it just will not survive the page.
        }
      }
      return next;
    });
  }

  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);
  const visibleColumns = columns.filter((c) => !hiddenSet.has(c.key));

  /** 1-based cell positions to hide, which is what nth-child counts. */
  const hiddenPositions = columns
    .map((c, i) => (hiddenSet.has(c.key) ? i + 1 : 0))
    .filter(Boolean);

  // Everything up to the first column that carries a figure.
  const spanWidth = footerCells
    ? (() => {
        const at = visibleColumns.findIndex((c) => c.key in footerCells.cells);
        return at === -1 ? visibleColumns.length : at;
      })()
    : 0;

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const chosen = Object.entries(picked).filter(([, v]) => v);
    return rows.filter((r) => {
      if (needle && !r.searchText.toLowerCase().includes(needle)) return false;
      return chosen.every(([k, v]) => r.facet?.[k] === v);
    });
  }, [rows, q, picked]);

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

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  // Searching down to two results while sitting on page 7 would otherwise show
  // an empty table and no clue why.
  const current = Math.min(page, pageCount);
  const start = (current - 1) * pageSize;
  const shown = sorted.slice(start, start + pageSize);

  useEffect(() => { setPage(1); }, [q, picked, pageSize, sort]);

  /**
   * Exports what is on screen — search applied, in the order displayed, and
   * now in the columns displayed too — rather than the rows and fields the
   * page started with. A file that disagrees with the table above it is worse
   * than no export at all, because the difference is invisible until someone
   * acts on the wrong list.
   *
   * Every matching row, though, not merely the current page: paging is how
   * much fits on a screen, and nobody exporting a list means "the ten I can
   * see".
   */
  function exportCsv() {
    const quote = (v: string | number | null | undefined) => {
      const t = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const fields = [
      ...visibleColumns.filter((c) => c.label.trim() !== ""),
      ...csvExtra,
    ];
    const lines = [
      fields.map((f) => quote(f.label)).join(","),
      ...sorted.map((r) => fields.map((f) => quote(r.csv?.[f.key])).join(",")),
    ];
    // A BOM, so Excel opens Burmese names as UTF-8 instead of mojibake.
    const blob = new Blob(["﻿" + lines.join("\n") + "\n"], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = csvFilename ?? "export.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const canExport = Boolean(csvFilename && rows.some((r) => r.csv));

  function toggleSort(key: string) {
    setSort((s) => {
      if (!s || s.key !== key) return { key, dir: "asc" };
      if (s.dir === "asc") return { key, dir: "desc" };
      return null;
    });
  }

  return (
    <>
      {/* Scoped to this table by a generated class, so two tables on one page
          hide different columns without touching each other. */}
      {hiddenPositions.length > 0 && (
        <style>{
          hiddenPositions
            .map((p) =>
              `.${scope} > thead > tr > th:nth-child(${p}),`
              + `.${scope} > tbody > tr > td:nth-child(${p}){display:none}`)
            .join("")
        }</style>
      )}

      <div className="dt-bar">
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={searchPlaceholder}
          aria-label="Search"
          style={{ maxWidth: 320 }}
        />
        {filters
          .filter((f) => f.options.length > 1)
          .map((f) => (
            <select
              key={f.key}
              aria-label={f.allLabel}
              value={picked[f.key] ?? ""}
              onChange={(e) => setPicked((p) => ({ ...p, [f.key]: e.target.value }))}
              style={{ width: "auto" }}
            >
              <option value="">{f.allLabel}</option>
              {f.options.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          ))}

        <span className="dt-spacer" />

        {canExport && (
          <button type="button" className="ghost" onClick={exportCsv} disabled={sorted.length === 0}>
            Export {sorted.length !== rows.length ? `${sorted.length} of ${rows.length}` : ""}
          </button>
        )}

        {hideable.length > 1 && (
          <div className="dt-cols">
            <button
              type="button"
              className="ghost"
              aria-expanded={pickerOpen}
              onClick={() => setPickerOpen(!pickerOpen)}
            >
              <Columns3 size={14} aria-hidden="true" /> Columns
              {hidden.length > 0 && <span className="dt-cols-n">{hidden.length} hidden</span>}
            </button>
            {pickerOpen && (
              <>
                {/* Closes on any click outside, including one that lands on
                    something else useful — a menu you have to dismiss twice
                    is a menu in the way. */}
                <div className="dt-cols-scrim" onClick={() => setPickerOpen(false)} aria-hidden="true" />
                <div className="dt-cols-menu" role="group" aria-label="Columns shown">
                  {hideable.map((c) => (
                    <label key={c.key} className="dt-cols-item">
                      <input
                        type="checkbox"
                        checked={!hiddenSet.has(c.key)}
                        onChange={() => toggleColumn(c.key)}
                      />
                      {c.label}
                    </label>
                  ))}
                  {hidden.length > 0 && (
                    <button type="button" className="ghost tiny dt-cols-reset"
                            onClick={() => { setHidden([]); if (storageKey) { try { localStorage.removeItem(`cols:${storageKey}`); } catch { /* nothing to clear */ } } }}>
                      Show all
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <div className="tablewrap">
        <table className={[tableClassName, scope].filter(Boolean).join(" ")}>
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
            {shown.map((r) => (
              <Fragment key={r.key}>{r.node}</Fragment>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={visibleColumns.length} className="empty">
                  {q ? "No matches" : emptyLabel}
                </td>
              </tr>
            )}
          </tbody>
          {footerCells ? (
            <tfoot>
              <tr>
                <td colSpan={spanWidth > 1 ? spanWidth : undefined}>{footerCells.span}</td>
                {visibleColumns.slice(spanWidth).map((c) => (
                  <td key={c.key} className={c.align === "r" ? "r" : undefined}>
                    {footerCells.cells[c.key] ?? null}
                  </td>
                ))}
              </tr>
            </tfoot>
          ) : footer ? (
            <tfoot>{footer}</tfoot>
          ) : null}
        </table>
      </div>

      {sorted.length > 0 && (
        <div className="dt-pager">
          <span className="dt-pager-count">
            {sorted.length <= pageSize
              ? `${sorted.length} row${sorted.length === 1 ? "" : "s"}`
              : `${start + 1}–${Math.min(start + pageSize, sorted.length)} of ${sorted.length}`}
          </span>

          <span className="dt-spacer" />

          <label className="dt-pager-size">
            <select
              aria-label="Rows per page"
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>{n} per page</option>
              ))}
            </select>
          </label>

          {pageCount > 1 && (
            <span className="dt-pager-nav">
              <button type="button" className="ghost tiny" aria-label="Previous page"
                      disabled={current === 1} onClick={() => setPage(current - 1)}>
                <ChevronLeft size={14} aria-hidden="true" />
              </button>
              <span className="dt-pager-page">{current} / {pageCount}</span>
              <button type="button" className="ghost tiny" aria-label="Next page"
                      disabled={current === pageCount} onClick={() => setPage(current + 1)}>
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            </span>
          )}
        </div>
      )}
    </>
  );
}
