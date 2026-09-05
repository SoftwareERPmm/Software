"use client";

import { useActionState, useState } from "react";
import type { ActionResult } from "@/lib/actions";

type Row = {
  id: string; item_code: string; item_name: string; uom_code: string;
  location_name: string; document_no: string; doc_date: string;
  partner_name: string | null;
  outstanding: string; provisional_unit_cost: string; outstanding_value: string;
  price_source: string | null; price_source_no: string | null;
};

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const qty = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 4 });

const SOURCE_LABEL: Record<string, string> = {
  PURCHASE_INVOICE: "Matched purchase invoice",
  GOODS_RECEIPT: "Goods receipt",
  NONE: "Never purchased",
};

/**
 * Reconciling stock the ERP was never told arrived.
 *
 * The price is shown, not asked for. It was decided when the goods went out —
 * from the supplier's purchase invoice where there was one — and the
 * adjustment has to value the returning units at exactly what the sale
 * charged for them. A box to type a different figure would let the correction
 * and the cost of sale disagree, which is the thing being fixed.
 *
 * Where the price came from is shown beside it, because a figure with no
 * provenance is one people either accept without reading or distrust without
 * being able to check.
 */
export function ReconcileStock({
  action, rows, today,
}: {
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  rows: Row[];
  today: string;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    action as never, null
  );
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const chosen = rows.filter((r) => picked.has(r.id));
  const totalValue = chosen.reduce((s, r) => s + Number(r.outstanding_value), 0);
  const totalUnits = chosen.reduce((s, r) => s + Number(r.outstanding), 0);

  return (
    <form action={formAction}>
      <div className="card">
        <div className="card-head">
          <h2>Stock reconciliation</h2>
          <span className="page-sub">
            {rows.length} item{rows.length === 1 ? "" : "s"} awaiting a receipt
          </span>
        </div>

        {state && "error" in state && (
          <div className="card-body"><div className="alert">{state.error}</div></div>
        )}

        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: "1%" }} />
                <th>Item</th><th>Warehouse</th><th>Went out on</th>
                <th className="r">Quantity</th>
                <th className="r">Inventory price</th>
                <th>Source</th>
                <th className="r">Adjustment value</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={picked.has(r.id) ? "" : undefined}>
                  <td>
                    <input type="checkbox" name="negative_stock_id" value={r.id}
                           checked={picked.has(r.id)} onChange={() => toggle(r.id)}
                           aria-label={`Reconcile ${r.item_name}`} />
                  </td>
                  <td className="wrap">
                    <strong>{r.item_name}</strong>
                    <div className="subline" style={{ color: "var(--muted)" }}>{r.item_code}</div>
                  </td>
                  <td>{r.location_name}</td>
                  <td className="code">
                    {r.document_no}
                    <div className="subline" style={{ color: "var(--muted)" }}>
                      {r.doc_date}{r.partner_name ? ` · ${r.partner_name}` : ""}
                    </div>
                  </td>
                  <td className="r">{qty(Number(r.outstanding))} {r.uom_code}</td>
                  <td className="r">{fmt(Number(r.provisional_unit_cost))}</td>
                  <td className="wrap" style={{ color: "var(--muted)" }}>
                    {SOURCE_LABEL[r.price_source ?? "NONE"] ?? r.price_source}
                    {r.price_source_no && (
                      <div className="subline code">{r.price_source_no}</div>
                    )}
                  </td>
                  <td className="r"><strong>{fmt(Number(r.outstanding_value))}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card-body">
          <div className="row" style={{ alignItems: "flex-end" }}>
            <div className="field">
              <label htmlFor="doc_date">Adjustment date</label>
              <input id="doc_date" name="doc_date" type="date" defaultValue={today} required />
            </div>
            <div className="field">
              <label htmlFor="memo">Note</label>
              <input id="memo" name="memo" type="text"
                     placeholder="Optional — why the stock was never recorded" />
            </div>
          </div>

          <p className="page-sub" style={{ marginTop: "0.5rem" }}>
            {chosen.length === 0
              ? "Choose the lines that have been found and counted."
              : `Adds ${qty(totalUnits)} unit${totalUnits === 1 ? "" : "s"} back at ` +
                `${fmt(totalValue)} in total, posting Dr Inventory / Cr Stock Adjustment. ` +
                `The price is the one these goods were charged out at — not a new figure.`}
          </p>
        </div>

        <div className="card-body" style={{ paddingTop: 0 }}>
          <button type="submit" disabled={pending || chosen.length === 0}>
            {pending ? "Reconciling…"
              : chosen.length === 0 ? "Confirm adjustment"
              : `Confirm adjustment — ${fmt(totalValue)}`}
          </button>
        </div>
      </div>
    </form>
  );
}
