"use client";

import { useActionState, useEffect, useState } from "react";
import type { ActionResult, PickerItem } from "@/lib/actions";
import { ItemPicker } from "./item-picker";
import { NegativeStockConfirm, type Shortfall } from "./negative-stock-confirm";

type Node = { id: string; code: string; segment: string; name: string; parent_id: string | null };
type Uom = { id: string; code: string; name: string };
type Partner = { id: string; code: string; name: string };
type Location = { id: string; code: string; name: string };
type StockRow = { item_id: string; location_id: string; qty_on_hand: string };
type FocReason = { id: string; code: string; name: string };
type OpenOrderLine = {
  order_id: string; order_no: string; partner_id: string; location_id: string;
  line_id: string; item_id: string; item_code: string; item_name: string;
  remaining_qty: string;
};

type Line = {
  key: number; itemId: string; qty: string;
  focQty: string; focReasonId: string;
  /** Set when the line came from an order, so the delivery credits that line. */
  sourceLineId?: string | null;
};

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 4 });

/**
 * A delivery raised on its own.
 *
 * Goods leave for reasons that have no invoice and no order behind them —
 * stock dropped at a shop to be billed at month end, samples given to a
 * customer, promotional stock. Requiring an order or an invoice to move them
 * would mean inventing a document describing a sale that did not happen, in
 * order to record goods that did leave.
 *
 * So the source order is optional, and left blank the delivery simply stands
 * on its own. Choosing one prefills what it still owes and credits the
 * delivery to those lines, which is what keeps an order's outstanding
 * quantity right.
 */
export function DeliveryForm({
  action, customers, items: initialItems, locations, categories, uoms,
  stockByLocation, focReasons, openOrders, today,
}: {
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  customers: Partner[];
  items: PickerItem[];
  locations: Location[];
  categories: Node[];
  uoms: Uom[];
  stockByLocation: StockRow[];
  focReasons: FocReason[];
  openOrders: OpenOrderLine[];
  today: string;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    action as never, null
  );

  const [items, setItems] = useState(initialItems);
  const [partnerId, setPartnerId] = useState("");
  const [locationId, setLocationId] = useState(locations[0]?.id ?? "");
  const [orderId, setOrderId] = useState("");
  const [lines, setLines] = useState<Line[]>([
    { key: 1, itemId: "", qty: "", focQty: "", focReasonId: "" },
  ]);
  const [negativeConfirmed, setNegativeConfirmed] = useState(false);
  const [askNegative, setAskNegative] = useState(false);

  const byId = (id: string) => items.find((i) => i.id === id);
  const setLine = (key: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const addLine = () =>
    setLines((ls) => [...ls, {
      key: Math.max(0, ...ls.map((l) => l.key)) + 1,
      itemId: "", qty: "", focQty: "", focReasonId: "",
    }]);
  const removeLine = (key: number) =>
    setLines((ls) => (ls.length === 1 ? ls : ls.filter((l) => l.key !== key)));

  const onHandHere = (itemId: string) =>
    Number(stockByLocation.find((r) => r.item_id === itemId && r.location_id === locationId)
      ?.qty_on_hand ?? 0);

  /** Orders still owing goods to the customer chosen, newest grouping first. */
  const ordersFor = Array.from(
    openOrders
      .filter((o) => !partnerId || o.partner_id === partnerId)
      .reduce((m, o) => {
        if (!m.has(o.order_id)) m.set(o.order_id, { no: o.order_no, lines: [] as OpenOrderLine[] });
        m.get(o.order_id)!.lines.push(o);
        return m;
      }, new Map<string, { no: string; lines: OpenOrderLine[] }>())
  );

  /** Picking an order fills in what it still owes, and credits each line to
   *  the order line it satisfies — otherwise the order never closes. */
  function pickOrder(id: string) {
    setOrderId(id);
    const found = ordersFor.find(([oid]) => oid === id);
    if (!found) return;
    const [, o] = found;
    setPartnerId(o.lines[0].partner_id);
    setLocationId(o.lines[0].location_id);
    setLines(o.lines.map((l, i) => ({
      key: i + 1, itemId: l.item_id, qty: String(Number(l.remaining_qty)),
      focQty: "", focReasonId: "", sourceLineId: l.line_id,
    })));
  }

  const issuing = (l: Line) => (Number(l.qty) || 0) + (Number(l.focQty) || 0);
  const shortages = lines.filter((l) => {
    if (!l.itemId) return false;
    return byId(l.itemId)?.is_stocked && issuing(l) > onHandHere(l.itemId);
  });
  const shortfalls: Shortfall[] = shortages.map((l) => {
    const item = byId(l.itemId);
    return {
      itemCode: item?.code ?? "", itemName: item?.name ?? "", uomCode: item?.uom_code ?? "",
      required: issuing(l), recorded: onHandHere(l.itemId),
    };
  });
  const shortfallKey = shortfalls.map((s) => `${s.itemCode}:${s.required}:${s.recorded}`).join("|");
  useEffect(() => { setNegativeConfirmed(false); }, [shortfallKey]);

  // A free quantity with no reason has nowhere to put its cost.
  useEffect(() => {
    const fallback = focReasons[0]?.id;
    if (!fallback) return;
    setLines((ls) =>
      ls.some((l) => Number(l.focQty) > 0 && !l.focReasonId)
        ? ls.map((l) => (Number(l.focQty) > 0 && !l.focReasonId
            ? { ...l, focReasonId: fallback } : l))
        : ls
    );
  }, [lines, focReasons]);

  // Charged and free go as separate lines, the free one carrying its reason,
  // so its cost lands in that expense instead of cost of sales.
  const payload = JSON.stringify(
    lines.flatMap((l) => {
      const out: unknown[] = [];
      if (l.itemId && Number(l.qty) > 0) {
        out.push({ itemId: l.itemId, qty: Number(l.qty), sourceLineId: l.sourceLineId ?? null });
      }
      if (l.itemId && Number(l.focQty) > 0) {
        out.push({
          itemId: l.itemId, qty: Number(l.focQty),
          focReasonId: l.focReasonId || focReasons[0]?.id,
          sourceLineId: null,
        });
      }
      return out;
    })
  );

  const nothingToPost = lines.every((l) => !l.itemId || issuing(l) <= 0);

  return (
    <form action={formAction} className="form">
      <input type="hidden" name="lines" value={payload} />
      <input type="hidden" name="source_document_id" value={orderId} />
      {negativeConfirmed && <input type="hidden" name="allow_negative_stock" value="true" />}

      {state && "error" in state && <div className="alert">{state.error}</div>}

      <div className="card">
        <div className="card-body">
          <div className="row">
            <div className="field">
              <label htmlFor="partner_id">Customer</label>
              <select id="partner_id" name="partner_id" value={partnerId} required
                      onChange={(e) => { setPartnerId(e.target.value); setOrderId(""); }}>
                <option value="">Choose a customer…</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>{c.code} · {c.name}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="location_id">From warehouse</label>
              <select id="location_id" name="location_id" value={locationId} required
                      onChange={(e) => setLocationId(e.target.value)}>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>{l.code} · {l.name}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="doc_date">Date</label>
              <input id="doc_date" name="doc_date" type="date" defaultValue={today} required />
            </div>
            <div className="field">
              <label htmlFor="reference">Ref / order ID</label>
              <input id="reference" name="reference" type="text" placeholder="Delivery note no." />
            </div>
          </div>

          {/* Optional on purpose. Blank is the ordinary case for this screen —
              goods leaving with nothing raised beforehand. */}
          <div className="row">
            <div className="field">
              <label htmlFor="order">Against a sales order</label>
              <select id="order" value={orderId} onChange={(e) => pickOrder(e.target.value)}>
                <option value="">None — deliver without an order</option>
                {ordersFor.map(([id, o]) => (
                  <option key={id} value={id}>{o.no}</option>
                ))}
              </select>
              <span className="hint">
                Choosing one fills in what it still owes and credits the delivery
                to it, so the order closes properly.
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Items</h2></div>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th className="r">On hand</th>
                <th className="r">Deliver</th>
                {focReasons.length > 0 && <th className="r">Free</th>}
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const item = byId(l.itemId);
                const short = item?.is_stocked && issuing(l) > onHandHere(l.itemId);
                return (
                  <tr key={l.key}>
                    <td style={{ minWidth: 240 }}>
                      <ItemPicker
                        mode="sales" items={items} categories={categories} uoms={uoms}
                        value={l.itemId}
                        onPick={(id) => setLine(l.key, { itemId: id })}
                        onCreated={(it) => { setItems((xs) => [...xs, it]); }}
                      />
                    </td>
                    <td className="r" style={{ color: short ? "var(--bad)" : undefined }}>
                      {!item ? "—" : item.is_stocked ? fmt(onHandHere(item.id)) : "service"}
                    </td>
                    <td className="narrow">
                      <input type="number" min="0" step="any" value={l.qty} aria-label="Deliver quantity"
                             onChange={(e) => setLine(l.key, { qty: e.target.value })} />
                    </td>
                    {focReasons.length > 0 && (
                      <td className="narrow">
                        <input type="number" min="0" step="any" value={l.focQty} placeholder="0"
                               aria-label="Free quantity"
                               onChange={(e) => setLine(l.key, { focQty: e.target.value })} />
                        {Number(l.focQty) > 0 && (
                          <select value={l.focReasonId} aria-label="Reason free"
                                  style={{ marginTop: "0.2rem" }}
                                  onChange={(e) => setLine(l.key, { focReasonId: e.target.value })}>
                            {focReasons.map((r) => (
                              <option key={r.id} value={r.id}>{r.name}</option>
                            ))}
                          </select>
                        )}
                      </td>
                    )}
                    <td className="tight">
                      <button type="button" className="ghost tiny" onClick={() => removeLine(l.key)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="card-body">
          <button type="button" className="ghost" onClick={addLine}>+ Line</button>
        </div>
      </div>

      {shortages.length > 0 && !negativeConfirmed && (
        <div className="alert">
          <strong>Recorded stock is insufficient</strong> for{" "}
          {shortages.map((l) => byId(l.itemId)?.code).join(", ")}. Reduce the
          quantity, or confirm the goods physically exist &mdash; posting will
          ask before recording negative stock.
        </div>
      )}
      {shortages.length > 0 && negativeConfirmed && (
        <div className="alert">
          <strong>Confirmed:</strong> the goods physically exist though the
          record shows fewer.{" "}
          <button type="button" className="ghost tiny"
                  onClick={() => setNegativeConfirmed(false)}>Undo</button>
        </div>
      )}

      <NegativeStockConfirm
        open={askNegative} shortfalls={shortfalls}
        onCancel={() => setAskNegative(false)}
        onConfirm={() => { setNegativeConfirmed(true); setAskNegative(false); }}
      />

      <div className="field">
        <label htmlFor="memo">Note</label>
        <textarea id="memo" name="memo" rows={2} placeholder="Optional — English or Myanmar" />
      </div>

      <div className="actions">
        <button
          type={shortages.length > 0 && !negativeConfirmed ? "button" : "submit"}
          onClick={shortages.length > 0 && !negativeConfirmed
            ? () => setAskNegative(true) : undefined}
          disabled={pending || !partnerId || nothingToPost}>
          {pending ? "Posting…" : "Post delivery"}
        </button>
        <span className="page-sub">
          Stock leaves at its FIFO cost and the cost is recognised. No revenue
          and no receivable &mdash; those belong to the invoice, whenever it
          is raised.
        </span>
      </div>
    </form>
  );
}
