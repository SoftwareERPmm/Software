"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
// From lib/format, not lib/db: lib/db also exports the postgres client, and
// importing it into a client component pulls the driver into the browser
// bundle — the build fails on tls/fs/perf_hooks rather than shipping it.
import { money, shortDate } from "@/lib/format";

/**
 * The documents list, rebuilt on the ERP shell in app/erp/.
 *
 * Three things carried over from the reference patterns, in the order they
 * matter:
 *
 *   The control panel is one row — actions, search, count — and it is the
 *   same row on every screen that adopts it. That consistency does more for
 *   how a product reads than any single screen's polish, which is why it is
 *   a component rather than page markup.
 *
 *   Rows are 40px and the type is 14px against a 16px root, so the density
 *   comes from the rows rather than from shrinking the spacing scale.
 *
 *   Search filters, it does not jump. A ledger is scanned, and a list that
 *   reorders under the cursor cannot be scanned.
 */

export type DocRow = {
  id: string;
  docNo: string | null;
  docType: string;
  status: string;
  partnerName: string | null;
  postingDate: string | null;
  dueDate: string | null;
  sourceDocNo: string | null;
  grossTotal: number;
};

type SortKey = "docNo" | "docType" | "partnerName" | "postingDate" | "grossTotal";

const LABEL: Record<string, string> = {
  PURCHASE_ORDER: "Purchase order", GOODS_RECEIPT: "Goods receipt",
  PURCHASE_INVOICE: "Purchase invoice", PURCHASE_RETURN: "Purchase return",
  SUPPLIER_PAYMENT: "Supplier payment", SALES_ORDER: "Sales order",
  DELIVERY: "Delivery", SALES_INVOICE: "Sales invoice",
  SALES_RETURN: "Sales return", CUSTOMER_RECEIPT: "Customer receipt",
  STOCK_ADJUSTMENT: "Stock adjustment", STOCK_TRANSFER: "Stock transfer",
  OPENING_BALANCE: "Opening balance", CASH_VOUCHER: "Cash voucher",
  BANK_VOUCHER: "Bank voucher", JOURNAL_VOUCHER: "Journal voucher",
  CASH_TRANSFER: "Cash transfer",
};
const label = (t: string) => LABEL[t] ?? t.toLowerCase().replace(/_/g, " ");

/** Purchases lean one way, sales the other — a tint carries that faster than reading the type. */
const SIDE: Record<string, "in" | "out"> = {
  PURCHASE_ORDER: "in", GOODS_RECEIPT: "in", PURCHASE_INVOICE: "in",
  PURCHASE_RETURN: "in", SUPPLIER_PAYMENT: "in",
  SALES_ORDER: "out", DELIVERY: "out", SALES_INVOICE: "out",
  SALES_RETURN: "out", CUSTOMER_RECEIPT: "out",
};

export function ErpDocumentList({
  rows, title, typeFilter,
}: {
  rows: DocRow[];
  title: string;
  /** Rendered as a removable facet, mirroring how the reference shell shows an active filter. */
  typeFilter?: { label: string; clearHref: string } | null;
}) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "postingDate", dir: "desc",
  });

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const matched = needle
      ? rows.filter((r) =>
          [r.docNo, label(r.docType), r.partnerName, r.sourceDocNo]
            .filter(Boolean).join(" ").toLowerCase().includes(needle))
      : rows;

    const dir = sort.dir === "asc" ? 1 : -1;
    return [...matched].sort((a, b) => {
      const x = a[sort.key], y = b[sort.key];
      if (x === y) return 0;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      return (x < y ? -1 : 1) * dir;
    });
  }, [rows, q, sort]);

  // The footer totals what is on screen. A search that hides half the ledger
  // and still shows the full total is a figure nobody can reconcile.
  const total = shown.reduce((s, r) => s + r.grossTotal, 0);

  const head = (key: SortKey, text: string, numeric = false) => (
    <th
      className={`erp-th ${numeric ? "erp-num" : ""}`}
      onClick={() => setSort((s) => ({ key, dir: s.key === key && s.dir === "desc" ? "asc" : "desc" }))}
      style={{ cursor: "pointer", userSelect: "none" }}
      aria-sort={sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      {text}
      <span style={{ opacity: sort.key === key ? 0.7 : 0, marginLeft: 4 }}>
        {sort.dir === "asc" ? "↑" : "↓"}
      </span>
    </th>
  );

  return (
    <div data-density="odoo">
      <div className="erp-panel">
        <Link href="/sales/new" className="erp-btn erp-btn-primary"
              style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }}>
          New
        </Link>
        <h1 style={{ fontSize: "var(--t-lg)", fontWeight: 600, margin: 0, letterSpacing: "var(--track-tight)" }}>
          {title}
        </h1>

        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 6,
                      maxWidth: 620, marginInline: "auto", minWidth: 220 }}>
          {typeFilter && (
            <span className="erp-facet">
              {typeFilter.label}
              <Link href={typeFilter.clearHref} aria-label="Clear filter"
                    style={{ color: "inherit", textDecoration: "none", padding: "0 2px" }}>
                &times;
              </Link>
            </span>
          )}
          <input
            className="erp-search" style={{ flex: 1 }}
            placeholder="Search number, partner, type…"
            value={q} onChange={(e) => setQ(e.target.value)}
            aria-label="Search documents"
          />
        </div>

        <span style={{ color: "var(--erp-fg-muted)", fontSize: "var(--erp-text-sm)",
                       fontFamily: "var(--erp-font-mono)", whiteSpace: "nowrap" }}>
          {shown.length === rows.length
            ? `${rows.length}`
            : `${shown.length} of ${rows.length}`}
        </span>
      </div>

      <div className="erp-sheet erp-scroll" style={{ borderTop: 0, borderRadius: 0 }}>
        <table className="erp-table">
          <thead>
            <tr>
              {head("docNo", "Number")}
              {head("postingDate", "Date")}
              {head("docType", "Type")}
              {head("partnerName", "Partner")}
              <th className="erp-th">From</th>
              <th className="erp-th">Status</th>
              {head("grossTotal", "Amount", true)}
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr className="erp-tr">
                <td className="erp-td" colSpan={7} style={{ color: "var(--erp-fg-muted)" }}>
                  {rows.length === 0 ? "No documents yet." : "Nothing matches that search."}
                </td>
              </tr>
            )}
            {shown.map((r) => (
              <tr key={r.id} className="erp-tr">
                <td className="erp-td">
                  <Link href={`/documents/${r.id}`}
                        style={{ color: "var(--erp-brand)", fontFamily: "var(--erp-font-mono)" }}>
                    {r.docNo ?? "draft"}
                  </Link>
                </td>
                <td className="erp-td" style={{ fontFamily: "var(--erp-font-mono)", color: "var(--erp-fg-muted)" }}>
                  {r.postingDate ? shortDate(r.postingDate) : "—"}
                </td>
                <td className="erp-td">
                  <span style={{
                    color: SIDE[r.docType] === "in" ? "var(--cr)"
                         : SIDE[r.docType] === "out" ? "var(--dr)" : "var(--erp-fg-muted)",
                  }}>
                    {label(r.docType)}
                  </span>
                </td>
                <td className="erp-td" style={{ maxWidth: 220 }}>{r.partnerName ?? "—"}</td>
                <td className="erp-td" style={{ fontFamily: "var(--erp-font-mono)", color: "var(--erp-fg-muted)" }}>
                  {r.sourceDocNo ?? "—"}
                </td>
                <td className="erp-td">
                  <span className={`pill ${r.status.toLowerCase()}`}>{r.status}</span>
                </td>
                <td className="erp-td erp-num">{money(r.grossTotal)}</td>
              </tr>
            ))}
          </tbody>
          {shown.length > 0 && (
            <tfoot>
              <tr className="erp-tr erp-total">
                <td className="erp-td" colSpan={6}>
                  {shown.length === rows.length ? "Total" : `Total of ${shown.length} shown`}
                </td>
                <td className="erp-td erp-num">{money(total)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
