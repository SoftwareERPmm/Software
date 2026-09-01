"use client";

import { useMemo, useState } from "react";
import { DataTable, type DataRow, type Column } from "./data-table";

/**
 * Wraps DataTable with a Normal/Consignment toggle. Both ticked — the
 * default — is "all"; there is no third "all" checkbox because that is
 * already what both together mean.
 *
 * Takes a plain string[] rather than a Set for the same reason DataTable
 * takes pre-rendered nodes: what crosses the server/client boundary here
 * should be the dullest possible data.
 */
export function StockTable({
  rows,
  consignmentItemIds,
  columns,
  searchPlaceholder,
  defaultSort,
  emptyLabel,
  footer,
}: {
  rows: DataRow[];
  /** Row keys (item ids) that currently carry consigned stock. */
  consignmentItemIds: string[];
  columns: Column[];
  searchPlaceholder?: string;
  defaultSort?: { key: string; dir: "asc" | "desc" };
  emptyLabel?: string;
  footer?: React.ReactNode;
}) {
  const [showNormal, setShowNormal] = useState(true);
  const [showConsignment, setShowConsignment] = useState(true);

  const consigned = useMemo(() => new Set(consignmentItemIds), [consignmentItemIds]);

  const filtered = useMemo(
    () => rows.filter((r) => (consigned.has(r.key) ? showConsignment : showNormal)),
    [rows, consigned, showNormal, showConsignment]
  );

  return (
    <>
      <div style={{ display: "flex", gap: "1.25rem", margin: "0 0 0.75rem" }}>
        <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", cursor: "pointer" }}>
          <input type="checkbox" checked={showNormal} onChange={(e) => setShowNormal(e.target.checked)} />
          Normal items
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", cursor: "pointer" }}>
          <input type="checkbox" checked={showConsignment} onChange={(e) => setShowConsignment(e.target.checked)} />
          Consignment items
        </label>
      </div>
      <DataTable
        rows={filtered}
        columns={columns}
        searchPlaceholder={searchPlaceholder}
        defaultSort={defaultSort}
        emptyLabel={showNormal || showConsignment ? emptyLabel : "Tick a box to show items"}
        footer={footer}
      />
    </>
  );
}
