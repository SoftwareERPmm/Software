"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { money, qty } from "@/lib/format";
import type { ActionResult } from "@/lib/actions";

type AgreementLine = {
  lineId: string; itemId: string; itemCode: string; itemName: string;
  pricingMethod: "PERCENTAGE" | "FIXED"; pricingValue: number;
  isActive: boolean; onHand: number;
};
type Agreement = {
  id: string; memo: string | null; partnerId: string; partnerCode: string;
  partnerName: string; lines: AgreementLine[];
};
type ConsignedStockRow = {
  item_id: string; item_code: string; item_name: string;
  location_code: string; location_name: string;
  consignor_code: string; consignor_name: string;
  pricing_method: "PERCENTAGE" | "FIXED"; pricing_value: string;
  on_hand: string;
};
type OwnedRow = { item_id: string; location_id: string; qty_on_hand: string };

const basis = (method: string, value: number | string) =>
  method === "PERCENTAGE" ? `${Number(value)}% of selling price` : `Fixed ${money(value)}/unit`;

export function ConsignmentHub({
  agreements, consignedStock, ownedStock, suppliers, items,
  createAgreementAction, addLineAction,
}: {
  agreements: Agreement[];
  consignedStock: ConsignedStockRow[];
  ownedStock: OwnedRow[];
  suppliers: { id: string; code: string; name: string }[];
  items: { id: string; code: string; name: string }[];
  createAgreementAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  addLineAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
}) {
  const [agState, agAction] = useActionState<ActionResult | null, FormData>(
    createAgreementAction as never, null);
  const [lineState, lineAction] = useActionState<ActionResult | null, FormData>(
    addLineAction as never, null);
  const [newAgreementOpen, setNewAgreementOpen] = useState(false);
  const [addingLineTo, setAddingLineTo] = useState<string | null>(null);
  const [method, setMethod] = useState<"PERCENTAGE" | "FIXED">("PERCENTAGE");

  const ownedFor = (itemId: string) =>
    ownedStock.filter((r) => r.item_id === itemId).reduce((s, r) => s + Number(r.qty_on_hand), 0);

  // Ownership made visible, not folded into one on-hand number: the whole
  // point of separate pools is defeated if the screen that reports stock
  // hides which pool it came from.
  const byItem = new Map<string, ConsignedStockRow[]>();
  for (const r of consignedStock) {
    const list = byItem.get(r.item_id) ?? [];
    list.push(r);
    byItem.set(r.item_id, list);
  }

  return (
    <div data-density="odoo">
      <div className="erp-panel">
        <h1 style={{ fontSize: "var(--t-lg)", fontWeight: 600, margin: 0 }}>Consignment</h1>
        <span style={{ marginLeft: "auto", display: "flex", gap: "0.5rem" }}>
          <Link href="/inventory/consignment/receive" className="erp-btn erp-btn-primary"
                style={{ textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
            Receive Consignment
          </Link>
          <Link href="/sales/consignment" className="erp-btn"
                style={{ textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
            Consignment Sale
          </Link>
        </span>
      </div>

      {/* ---- ownership: what is on the shelf, and whose it is ---- */}
      <div className="erp-sheet" style={{ margin: "1rem", borderRadius: "var(--erp-radius)" }}>
        <div style={{ padding: "0.6rem 0.9rem", borderBottom: "1px solid var(--erp-border)", fontWeight: 600 }}>
          Consigned stock on hand
        </div>
        {consignedStock.length === 0 ? (
          <div style={{ padding: "1rem", color: "var(--erp-fg-muted)" }}>
            No consigned stock on hand. Receive some to see it here.
          </div>
        ) : (
          <div className="erp-scroll">
            <table className="erp-table">
              <thead>
                <tr>
                  <th className="erp-th">Item</th>
                  <th className="erp-th erp-num">On hand</th>
                  <th className="erp-th erp-num">Owned</th>
                  <th className="erp-th erp-num">Consigned</th>
                  <th className="erp-th">Consignor</th>
                  <th className="erp-th">Warehouse</th>
                  <th className="erp-th">Settlement</th>
                </tr>
              </thead>
              <tbody>
                {[...byItem.entries()].map(([itemId, rows]) =>
                  rows.map((r, i) => {
                    const owned = i === 0 ? ownedFor(itemId) : null;
                    const totalConsigned = rows.reduce((s, x) => s + Number(x.on_hand), 0);
                    return (
                      <tr key={r.item_id + r.consignor_code + r.location_code} className="erp-tr">
                        <td className="erp-td">
                          {i === 0 ? <><span className="erp-item-code">{r.item_code}</span>{r.item_name}</> : ""}
                        </td>
                        <td className="erp-td erp-num">
                          {i === 0 ? qty((owned ?? 0) + totalConsigned) : ""}
                        </td>
                        <td className="erp-td erp-num">{i === 0 ? qty(owned ?? 0) : ""}</td>
                        <td className="erp-td erp-num"><strong>{qty(Number(r.on_hand))}</strong></td>
                        <td className="erp-td">{r.consignor_name}</td>
                        <td className="erp-td" style={{ color: "var(--erp-fg-muted)" }}>{r.location_name}</td>
                        <td className="erp-td" style={{ color: "var(--erp-fg-muted)" }}>
                          {basis(r.pricing_method, r.pricing_value)}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ---- agreements ---- */}
      <div className="erp-sheet" style={{ margin: "1rem", borderRadius: "var(--erp-radius)" }}>
        <div style={{ padding: "0.6rem 0.9rem", borderBottom: "1px solid var(--erp-border)",
                      display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontWeight: 600 }}>Consignment agreements</span>
          <button type="button" className="erp-btn" onClick={() => setNewAgreementOpen((v) => !v)}>
            {newAgreementOpen ? "Cancel" : "+ New agreement"}
          </button>
        </div>

        {newAgreementOpen && (
          <form action={agAction} style={{ padding: "0.75rem 0.9rem", borderBottom: "1px solid var(--erp-border)",
                                            display: "flex", gap: "0.6rem", alignItems: "flex-end", flexWrap: "wrap" }}>
            <div>
              <label style={{ display: "block", fontSize: "var(--erp-text-xs)", color: "var(--erp-fg-muted)" }}>
                Consignor (supplier)
              </label>
              <select name="partner_id" required>
                <option value="">Choose…</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}
              </select>
            </div>
            <div style={{ flex: 1, minWidth: 180 }}>
              <label style={{ display: "block", fontSize: "var(--erp-text-xs)", color: "var(--erp-fg-muted)" }}>
                Memo (optional)
              </label>
              <input name="memo" type="text" placeholder="Standard terms" style={{ width: "100%" }} />
            </div>
            <button type="submit" className="erp-btn erp-btn-primary">Create agreement</button>
            {agState && "error" in agState && <span style={{ color: "var(--bad)" }}>{agState.error}</span>}
          </form>
        )}

        {agreements.length === 0 ? (
          <div style={{ padding: "1rem", color: "var(--erp-fg-muted)" }}>
            No consignment agreements yet. A supplier needs one before you can receive goods on their behalf.
          </div>
        ) : (
          agreements.map((ag) => (
            <div key={ag.id} style={{ borderBottom: "1px solid var(--erp-border)" }}>
              <div style={{ padding: "0.6rem 0.9rem", display: "flex", justifyContent: "space-between",
                            alignItems: "center", background: "var(--erp-surface-sunken)" }}>
                <span>
                  <strong>{ag.partnerName}</strong>
                  {ag.memo && <span style={{ color: "var(--erp-fg-muted)" }}> — {ag.memo}</span>}
                </span>
                <button type="button" className="erp-btn"
                        onClick={() => setAddingLineTo(addingLineTo === ag.id ? null : ag.id)}>
                  {addingLineTo === ag.id ? "Cancel" : "+ Add item"}
                </button>
              </div>

              {addingLineTo === ag.id && (
                <form action={lineAction} style={{ padding: "0.6rem 0.9rem", display: "flex",
                                                     gap: "0.6rem", alignItems: "flex-end", flexWrap: "wrap" }}>
                  <input type="hidden" name="agreement_id" value={ag.id} />
                  <div>
                    <label style={{ display: "block", fontSize: "var(--erp-text-xs)", color: "var(--erp-fg-muted)" }}>Item</label>
                    <select name="item_id" required>
                      <option value="">Choose…</option>
                      {items.map((it) => <option key={it.id} value={it.id}>{it.code} · {it.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: "var(--erp-text-xs)", color: "var(--erp-fg-muted)" }}>Settlement</label>
                    <select name="pricing_method" value={method} onChange={(e) => setMethod(e.target.value as never)}>
                      <option value="PERCENTAGE">Percentage of selling price</option>
                      <option value="FIXED">Fixed amount per unit</option>
                    </select>
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: "var(--erp-text-xs)", color: "var(--erp-fg-muted)" }}>
                      {method === "PERCENTAGE" ? "Percent" : "Amount / unit"}
                    </label>
                    <input name="pricing_value" type="number" step="0.01" min="0"
                           max={method === "PERCENTAGE" ? 100 : undefined} required style={{ width: 110 }} />
                  </div>
                  <button type="submit" className="erp-btn erp-btn-primary">Add</button>
                  {lineState && "error" in lineState && <span style={{ color: "var(--bad)" }}>{lineState.error}</span>}
                </form>
              )}

              {ag.lines.length > 0 && (
                <table className="erp-table">
                  <tbody>
                    {ag.lines.map((l) => (
                      <tr key={l.lineId} className="erp-tr">
                        <td className="erp-td" style={{ paddingLeft: "1.5rem" }}>
                          <span className="erp-item-code">{l.itemCode}</span>{l.itemName}
                        </td>
                        <td className="erp-td" style={{ color: "var(--erp-fg-muted)" }}>
                          {basis(l.pricingMethod, l.pricingValue)}
                        </td>
                        <td className="erp-td erp-num">
                          {l.onHand > 0 ? `${qty(l.onHand)} on hand` : "none on hand"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
