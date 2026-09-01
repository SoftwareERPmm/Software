"use client";

import { useActionState, useMemo, useState } from "react";
import { money, qty as fmtQty } from "@/lib/format";
import type { ActionResult } from "@/lib/actions";

type Batch = {
  item_id: string; item_code: string; item_name: string;
  location_id: string; consignor_id: string; consignor_code: string; consignor_name: string;
  pricing_method: "PERCENTAGE" | "FIXED"; pricing_value: string; on_hand: string;
};
type Line = { key: number; itemId: string; batchKey: string; qty: string; unitPrice: string };

const batchKey = (b: Batch) => `${b.item_id}::${b.consignor_id}::${b.pricing_method}::${b.pricing_value}`;

const settlementOf = (b: Batch, qty: number, unitPrice: number) => {
  const method = b.pricing_method;
  const value = Number(b.pricing_value);
  return method === "PERCENTAGE" ? round2(qty * unitPrice * (value / 100)) : round2(qty * value);
};
function round2(n: number) { return Math.round(n * 100) / 100; }

export function ConsignmentSaleForm({
  allBatches, customers, locations, today, action,
}: {
  allBatches: (Batch & { location_code: string; location_name: string })[];
  customers: { id: string; code: string; name: string }[];
  locations: { id: string; code: string; name: string }[];
  today: string;
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(action as never, null);
  const [partnerId, setPartnerId] = useState("");
  const [locationId, setLocationId] = useState(
    locations.find((l) => allBatches.some((b) => b.location_id === l.id))?.id ?? locations[0]?.id ?? ""
  );
  const [docDate, setDocDate] = useState(today);
  const [lines, setLines] = useState<Line[]>([{ key: 1, itemId: "", batchKey: "", qty: "", unitPrice: "" }]);

  const batches = useMemo(() => allBatches.filter((b) => b.location_id === locationId), [allBatches, locationId]);

  const byItem = useMemo(() => {
    const m = new Map<string, Batch[]>();
    for (const b of batches) {
      const list = m.get(b.item_id) ?? [];
      list.push(b);
      m.set(b.item_id, list);
    }
    return m;
  }, [batches]);
  const items = useMemo(() => {
    const seen = new Map<string, { id: string; code: string; name: string }>();
    for (const b of batches) seen.set(b.item_id, { id: b.item_id, code: b.item_code, name: b.item_name });
    return [...seen.values()].sort((a, b) => a.code.localeCompare(b.code));
  }, [batches]);

  const setLine = (key: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const addLine = () =>
    setLines((ls) => [...ls, { key: Math.max(0, ...ls.map((l) => l.key)) + 1, itemId: "", batchKey: "", qty: "", unitPrice: "" }]);
  const removeLine = (key: number) => setLines((ls) => ls.filter((l) => l.key !== key));

  const rows = lines.map((l) => {
    const options = byItem.get(l.itemId) ?? [];
    const batch = options.find((b) => batchKey(b) === l.batchKey) ?? options[0] ?? null;
    const q = Number(l.qty) || 0;
    const price = Number(l.unitPrice) || 0;
    const customerSale = round2(q * price);
    const consignorAmount = batch ? settlementOf(batch, q, price) : 0;
    const margin = round2(customerSale - consignorAmount);
    return { line: l, options, batch, q, price, customerSale, consignorAmount, margin };
  });

  const totalSale = rows.reduce((s, r) => s + r.customerSale, 0);
  const totalSettlement = rows.reduce((s, r) => s + r.consignorAmount, 0);
  const totalMargin = round2(totalSale - totalSettlement);

  const payload = JSON.stringify(
    rows.filter((r) => r.q > 0 && r.price > 0)
        .map((r) => ({ itemId: r.line.itemId, qty: r.q, unitPrice: r.price }))
  );
  const canSubmit = partnerId && rows.some((r) => r.q > 0 && r.price > 0)
    && rows.every((r) => !r.batch || r.q <= Number(r.batch.on_hand));

  return (
    <form action={formAction} data-density="odoo">
      <input type="hidden" name="lines" value={payload} />
      <input type="hidden" name="location_id" value={locationId} />
      <div className="erp-sheet-page" style={{ maxWidth: 820 }}>
        <div className="erp-doc-title">
          <h1 style={{ fontSize: "var(--t-xl)" }}>Consignment Sale</h1>
        </div>

        <div className="erp-fields">
          <div>
            <label style={{ display: "block", fontSize: "var(--erp-text-sm)", color: "var(--erp-fg-muted)" }}>Customer</label>
            <select name="partner_id" value={partnerId} onChange={(e) => setPartnerId(e.target.value)} required>
              <option value="">Choose a customer…</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
            </select>
          </div>
          <div>
            <label style={{ display: "block", fontSize: "var(--erp-text-sm)", color: "var(--erp-fg-muted)" }}>Warehouse</label>
            <select value={locationId}
                    onChange={(e) => { setLocationId(e.target.value); setLines([{ key: 1, itemId: "", batchKey: "", qty: "", unitPrice: "" }]); }}>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.code} · {l.name}</option>)}
            </select>
          </div>
          <div>
            <label style={{ display: "block", fontSize: "var(--erp-text-sm)", color: "var(--erp-fg-muted)" }}>Date</label>
            <input name="doc_date" type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)} required />
          </div>
        </div>

        {batches.length === 0 ? (
          <div style={{ padding: "1rem", color: "var(--warn)" }}>
            No consigned stock on hand at this warehouse. Receive some first.
          </div>
        ) : (
          <>
            <div className="erp-tabs"><span className="erp-tab here">Items</span></div>
            {rows.map((r) => (
              <div key={r.line.key} style={{ border: "1px solid var(--erp-border)", borderRadius: "var(--erp-radius)",
                                              padding: "0.75rem", margin: "0.6rem 0" }}>
                <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", alignItems: "flex-end" }}>
                  <div style={{ flex: 2, minWidth: 200 }}>
                    <label style={{ display: "block", fontSize: "var(--erp-text-xs)", color: "var(--erp-fg-muted)" }}>Item</label>
                    <select value={r.line.itemId}
                            onChange={(e) => {
                              const opts = byItem.get(e.target.value) ?? [];
                              setLine(r.line.key, { itemId: e.target.value, batchKey: opts[0] ? batchKey(opts[0]) : "", qty: "" });
                            }}>
                      <option value="">Choose an item…</option>
                      {items.map((it) => <option key={it.id} value={it.id}>{it.code} · {it.name}</option>)}
                    </select>
                  </div>

                  {r.options.length > 1 && (
                    <div style={{ flex: 2, minWidth: 220 }}>
                      <label style={{ display: "block", fontSize: "var(--erp-text-xs)", color: "var(--erp-fg-muted)" }}>Consignor</label>
                      <select value={r.line.batchKey} onChange={(e) => setLine(r.line.key, { batchKey: e.target.value, qty: "" })}>
                        {r.options.map((b) => (
                          <option key={batchKey(b)} value={batchKey(b)}>
                            {b.consignor_name} — {fmtQty(Number(b.on_hand))} on hand
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div>
                    <label style={{ display: "block", fontSize: "var(--erp-text-xs)", color: "var(--erp-fg-muted)" }}>
                      Quantity {r.batch && <span>(max {fmtQty(Number(r.batch.on_hand))})</span>}
                    </label>
                    <input type="number" min="0" step="0.01" value={r.line.qty}
                           onChange={(e) => setLine(r.line.key, { qty: e.target.value })}
                           style={{ width: 100, textAlign: "right",
                                    borderColor: r.batch && r.q > Number(r.batch.on_hand) ? "var(--bad)" : undefined }} />
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: "var(--erp-text-xs)", color: "var(--erp-fg-muted)" }}>Selling price</label>
                    <input type="number" min="0" step="0.01" value={r.line.unitPrice}
                           onChange={(e) => setLine(r.line.key, { unitPrice: e.target.value })}
                           style={{ width: 110, textAlign: "right" }} />
                  </div>
                  {lines.length > 1 && (
                    <button type="button" className="erp-btn" onClick={() => removeLine(r.line.key)}>Remove</button>
                  )}
                </div>

                {r.batch && r.q > 0 && r.price > 0 && (
                  <div style={{ marginTop: "0.6rem", paddingTop: "0.6rem", borderTop: "1px dashed var(--erp-border)",
                                display: "grid", gridTemplateColumns: "1fr auto", gap: "0.15rem 1.5rem", fontSize: "var(--erp-text-sm)" }}>
                    <span style={{ color: "var(--erp-fg-muted)" }}>Settlement</span>
                    <span>
                      {r.batch.pricing_method === "PERCENTAGE"
                        ? `${Number(r.batch.pricing_value)}% of selling price`
                        : `Fixed ${money(r.batch.pricing_value)}/unit`}
                    </span>
                    <span style={{ color: "var(--erp-fg-muted)" }}>Customer pays</span>
                    <span className="erp-num" style={{ fontFamily: "var(--erp-font-mono)" }}>{money(r.customerSale)}</span>
                    <span style={{ color: "var(--erp-fg-muted)" }}>Owed to {r.batch.consignor_name}</span>
                    <span className="erp-num" style={{ fontFamily: "var(--erp-font-mono)" }}>{money(r.consignorAmount)}</span>
                    <strong>Your margin</strong>
                    <strong className="erp-num" style={{ fontFamily: "var(--erp-font-mono)", color: "var(--erp-brand)" }}>
                      {money(r.margin)}
                    </strong>
                  </div>
                )}
                {r.batch && r.q > Number(r.batch.on_hand) && (
                  <div style={{ color: "var(--bad)", fontSize: "var(--erp-text-sm)", marginTop: "0.4rem" }}>
                    Only {fmtQty(Number(r.batch.on_hand))} of this consignor&rsquo;s stock is on hand.
                  </div>
                )}
              </div>
            ))}

            <button type="button" className="erp-btn" onClick={addLine}>+ Add another item</button>

            <div className="erp-foot">
              <div />
              <dl className="erp-totals">
                <dt>Customer total</dt><dd>{money(totalSale)}</dd>
                <dt>Owed to consignors</dt><dd>{money(totalSettlement)}</dd>
                <dt className="grand">Your margin</dt><dd className="grand">{money(totalMargin)}</dd>
              </dl>
            </div>
          </>
        )}

        <div className="erp-foot" style={{ justifyContent: "flex-end" }}>
          {state && "error" in state && <span style={{ color: "var(--bad)", marginRight: "auto" }}>{state.error}</span>}
          <button type="submit" className="erp-btn erp-btn-primary" disabled={pending || !canSubmit}>
            {pending ? "Posting…" : "Post Consignment Sale"}
          </button>
        </div>
      </div>
    </form>
  );
}
