"use client";

import { useMemo, useState } from "react";
import { Layers, Home, Users } from "lucide-react";
import { DataTable, type DataRow, type Column } from "./data-table";

type Scope = "all" | "owned" | "consigned";

/**
 * Wraps DataTable with the ownership picker.
 *
 * Two checkboxes said the same thing three ways: both ticked, neither ticked,
 * one ticked. Neither ticked is a table showing nothing, which is a state
 * worth having only if somebody wants it, and nobody does. Three exclusive
 * tabs carry the same choices with one fewer, and each one says how many rows
 * it holds before it is picked — a Consignment tab reading 0 answers the
 * question without being clicked.
 */
export function StockTable({
  rows,
  consignmentItemIds,
  columns,
  searchPlaceholder,
  defaultSort,
  emptyLabel,
  footerCells,
}: {
  rows: DataRow[];
  /** Row keys (item ids) that currently carry consigned stock. */
  consignmentItemIds: string[];
  columns: Column[];
  searchPlaceholder?: string;
  defaultSort?: { key: string; dir: "asc" | "desc" };
  emptyLabel?: string;
  footerCells?: { span: React.ReactNode; cells: Record<string, React.ReactNode> };
}) {
  const [scope, setScope] = useState<Scope>("all");

  const consigned = useMemo(() => new Set(consignmentItemIds), [consignmentItemIds]);

  const counts = {
    all: rows.length,
    consigned: rows.filter((r) => consigned.has(r.key)).length,
    owned: rows.filter((r) => !consigned.has(r.key)).length,
  };

  const filtered = useMemo(
    () => rows.filter((r) =>
      scope === "all" ? true : consigned.has(r.key) ? scope === "consigned" : scope === "owned"),
    [rows, consigned, scope]
  );

  const tabs: { key: Scope; label: string; icon: React.ReactNode }[] = [
    { key: "all", label: "All stock", icon: <Layers size={14} aria-hidden="true" /> },
    { key: "owned", label: "Company-owned", icon: <Home size={14} aria-hidden="true" /> },
    { key: "consigned", label: "Consignment", icon: <Users size={14} aria-hidden="true" /> },
  ];

  return (
    <>
      <div className="scopetabs" role="group" aria-label="Ownership">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            className="scopetab"
            data-active={scope === t.key}
            aria-pressed={scope === t.key}
            onClick={() => setScope(t.key)}
          >
            {t.icon}
            {t.label}
            <span className="scopetab-n">{counts[t.key]}</span>
          </button>
        ))}
      </div>
      <DataTable
        rows={filtered}
        columns={columns}
        searchPlaceholder={searchPlaceholder}
        defaultSort={defaultSort}
        emptyLabel={
          scope === "consigned" ? "Nothing on hand from a consignor"
            : scope === "owned" ? "Nothing company-owned on hand"
              : emptyLabel
        }
        footerCells={footerCells}
        tableClassName="stocktable"
        storageKey="stock"
      />
    </>
  );
}
