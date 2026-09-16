"use client";

import { useActionState, useEffect, useState } from "react";
import type { ActionResult, PickerItem } from "@/lib/actions";
import { ItemPicker } from "./item-picker";
import { PartnerPicker } from "./partner-picker";

type Item = PickerItem;
type Node = { id: string; code: string; segment: string; name: string; parent_id: string | null };
type Partner = { id: string; code: string; name: string };
type Location = { id: string; code: string; name: string };
type Line = { key: number; itemId: string; qty: string; unitPrice: string };
type SalesDoc = { id: string; doc_type: string; doc_no: string; doc_date: Date | string;
  partner_id: string; rates?: Record<string, number> };

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
// postgres.js sends `date` columns over as Date objects, not strings.
const fmtDate = (d: Date | string) => (typeof d === "string" ? d : d.toISOString()).slice(0, 10);

/**
 * The inverse of an invoice, in every sense that matters for the UI: a
 * sales return brings stock IN (no on-hand check — the opposite of a sale),
 * a purchase return sends stock OUT (on-hand check applies — the opposite
 * of a purchase). Reusing InvoiceForm's shortage logic as-is would check
 * the wrong direction for both.
 */
export function ReturnForm({
  kind,
  action,
  partners,
  items: initialItems,
  locations,
  today,
  categories,
  uoms,
  salesDocs,
  prefill,
}: {
  kind: "sales" | "purchase";
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  partners: Partner[];
  items: Item[];
  locations: Location[];
  today: string;
  categories: Node[];
  uoms: { id: string; code: string; name: string }[];
  salesDocs?: SalesDoc[];
  /**
   * Arrived here from a goods receipt being cancelled because the goods went
   * back. Everything this return needs is already on that receipt, so it is
   * carried across rather than asked for again.
   */
  prefill?: {
    sourceDocumentId: string; docNo: string; partnerId: string; locationId: string;
    lines: { itemId: string; qty: string; unitPrice: string }[];
  } | null;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    action as never,
    null
  );

  /** See the hidden field below. */
  const [attemptKey] = useState(() => crypto.randomUUID());

  const [items, setItems] = useState<Item[]>(initialItems);
  const addItem = (i: Item) => setItems((xs) => [...xs, i]);

  const [lines, setLines] = useState<Line[]>(() =>
    prefill && prefill.lines.length > 0
      ? prefill.lines.map((l, i) => ({ key: i + 1, ...l }))
      : [{ key: 1, itemId: "", qty: "", unitPrice: "" }]);
  const [partnerId, setPartnerId] = useState(prefill?.partnerId ?? "");
  const [docDate, setDocDate] = useState(today);
  const [sourceDocumentId, setSourceDocumentId] = useState(prefill?.sourceDocumentId ?? "");
  const [receivedTime, setReceivedTime] = useState("");

  useEffect(() => {
    setReceivedTime(new Date().toTimeString().slice(0, 5));
  }, []);

  const isSales = kind === "sales";
  const byId = (id: string) => items.find((i) => i.id === id);
  const returnableDocs = (salesDocs ?? []).filter((d) => d.partner_id === partnerId);
  const sourceDoc = returnableDocs.find((d) => d.id === sourceDocumentId);
  const sourceIsReceipt = sourceDoc?.doc_type === "GOODS_RECEIPT";

  /**
   * A return against a receipt is priced by that receipt, because what it
   * has to do is clear an accrual of a known size — return a hundred units
   * that arrived at 500 and 50,000 comes off, whatever anyone types. The
   * engine derives it either way; showing something else here would be the
   * screen promising a figure the engine will not post.
   */
  const receiptRate = (itemId: string): number | null => {
    if (!sourceIsReceipt) return null;
    const r = sourceDoc?.rates?.[itemId];
    return r === undefined || r === null ? null : Number(r);
  };

  function setLine(key: number, patch: Partial<Line>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function pickItem(key: number, itemId: string) {
    const item = byId(itemId);
    const fromReceipt = receiptRate(itemId);
    if (fromReceipt !== null) {
      setLine(key, { itemId, unitPrice: String(fromReceipt) });
      return;
    }
    const price = !item ? "" : isSales ? item.sale_price : item.next_cost;
    setLine(key, { itemId, unitPrice: Number(price) > 0 ? String(Number(price)) : "" });
  }

  // Switching the source re-prices what is already on the form. On a prefilled
  // return this runs once on mount and arrives at the figures already there —
  // both come from the receipt's own rate, which is the point.
  // Picking
  // receipt after the lines were entered is the ordinary way round, and
  // leaving yesterday's next_cost sitting in a locked field would be worse
  // than leaving it editable.
  useEffect(() => {
    setLines((ls) => ls.map((l) => {
      const fromReceipt = l.itemId ? receiptRate(l.itemId) : null;
      return fromReceipt === null ? l : { ...l, unitPrice: String(fromReceipt) };
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceDocumentId]);

  const addLine = () =>
    setLines((ls) => [...ls, { key: Math.max(0, ...ls.map((l) => l.key)) + 1, itemId: "", qty: "", unitPrice: "" }]);

  const removeLine = (key: number) =>
    setLines((ls) => (ls.length === 1 ? ls : ls.filter((l) => l.key !== key)));

  const amount = (l: Line) => (Number(l.qty) || 0) * (Number(l.unitPrice) || 0);
  const total = lines.reduce((s, l) => s + amount(l), 0);

  const payload = JSON.stringify(
    lines
      .filter((l) => l.itemId && Number(l.qty) > 0)
      .map((l) => ({ itemId: l.itemId, qty: Number(l.qty), unitPrice: Number(l.unitPrice) || 0 }))
  );

  // Only a purchase return removes stock — a sales return adds it, so
  // there's nothing to run short of.
  const shortages = lines.filter((l) => {
    if (isSales || !l.itemId) return false;
    const item = byId(l.itemId);
    return item?.is_stocked && Number(l.qty) > Number(item.on_hand);
  });

  return (
    <form action={formAction} className="form wide">
      {/* One submission, one posting. Generated when this form mounts, so a
          double-click or a resent request carries the same key and is handed
          the document the first one posted; a new form is a new key. */}
      <input type="hidden" name="idempotency_key" value={attemptKey} />

      {state && "error" in state && <div className="alert">{state.error}</div>}

      <input type="hidden" name="lines" value={payload} />

      <div className="card">
        <div className="card-head">
          <h2>{isSales ? "Customer" : "Supplier"} and date</h2>
        </div>
        <div className="card-body">
          <div className="row">
            <div className="field">
              <label htmlFor="partner_id">{isSales ? "Customer" : "Supplier"}</label>
              <PartnerPicker
                partners={partners as never}
                value={partnerId}
                onPick={(id) => { setPartnerId(id); setSourceDocumentId(""); }}
              />
            </div>

            <div className="field">
              <label htmlFor="location_id">Warehouse</label>
              {/* The receipt's own warehouse where there is one: goods that
                  came into Mandalay go back from Mandalay, and asking again
                  invites picking the wrong shelf. */}
              <select id="location_id" name="location_id" required
                      defaultValue={prefill?.locationId || locations[0]?.id || ""}>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>{l.code} · {l.name}</option>
                ))}
              </select>
            </div>

            {(
              <div className="field">
                <label htmlFor="source_document_id">Return against</label>
                <select id="source_document_id" name="source_document_id" value={sourceDocumentId}
                  onChange={(e) => setSourceDocumentId(e.target.value)} disabled={!partnerId}>
                  <option value="">
                    {!partnerId
                      ? `Choose a ${isSales ? "customer" : "supplier"} first`
                      : isSales
                        ? "Not on a specific invoice"
                        : "Not against a specific receipt or bill"}
                  </option>
                  {returnableDocs.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.doc_no} ·{" "}
                      {d.doc_type === "DELIVERY" ? "delivery"
                        : d.doc_type === "GOODS_RECEIPT" ? "goods receipt"
                        : "invoice"} · {fmtDate(d.doc_date)}
                    </option>
                  ))}
                </select>
                <span className="page-sub">
                  {/* What is returned against decides what the return gives
                      back, not only what it costs. A bill means the supplier
                      owes a credit; a receipt they never billed means the
                      accrual for goods we no longer have comes off instead. */}
                  {!sourceDocumentId
                    ? isSales
                      ? "Leave blank to cost the return at current stock value."
                      : "Leave blank to cost the return at current stock value — "
                        + "choose the receipt these goods came in on where you can, "
                        + "so the return takes back what that receipt put on."
                    : isSales
                      ? "Returned stock is costed at what it actually sold for on this document."
                      : sourceIsReceipt
                        ? "Goods go back and the accrual this receipt raised comes off with "
                          + "them. Nothing is charged to the supplier: they have not billed "
                          + "for these."
                        : "The supplier is owed less by what goes back."}
                </span>
              </div>
            )}

            <div className="field">
              <label htmlFor="doc_date">Date</label>
              <input id="doc_date" name="doc_date" type="date" value={docDate}
                onChange={(e) => setDocDate(e.target.value)} required />
            </div>

            {isSales && (
              <div className="field">
                <label htmlFor="received_time">Time</label>
                <input id="received_time" name="received_time" type="time" value={receivedTime}
                  onChange={(e) => setReceivedTime(e.target.value)} />
                <span className="hint">Orders same-day stock-ins correctly for FIFO</span>
              </div>
            )}

            <div className="field">
              <label htmlFor="reference">Reference</label>
              <input id="reference" name="reference" type="text"
                placeholder={isSales ? "Their reason / RMA no." : "Debit note no."} />
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Lines</h2>
          <button type="button" className="ghost tiny" onClick={addLine}>Add line</button>
        </div>

        <div className="tablewrap">
          <table className="linetable">
            <thead>
              <tr>
                <th>Item</th>
                <th className="r">{isSales ? "Ref. cost" : "On hand"}</th>
                <th className="r">Qty</th>
                <th className="r">Unit price</th>
                <th className="r">Amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const item = byId(l.itemId);
                const short = !isSales && item?.is_stocked && Number(l.qty) > Number(item.on_hand);

                return (
                  <tr key={l.key}>
                    <td style={{ minWidth: 240 }}>
                      <ItemPicker
                        mode={kind}
                        items={items}
                        categories={categories}
                        uoms={uoms}
                        value={l.itemId}
                        onPick={(id) => pickItem(l.key, id)}
                        onCreated={addItem}
                      />
                    </td>
                    <td className="r">
                      {!item ? (
                        "—"
                      ) : isSales ? (
                        fmt(Number(item.next_cost))
                      ) : (
                        <span style={{ color: short ? "var(--bad)" : undefined }}>
                          {item.is_stocked ? fmt(Number(item.on_hand)) : "service"}
                        </span>
                      )}
                    </td>
                    <td className="narrow">
                      <input type="number" min="0" step="any" value={l.qty}
                        onChange={(e) => setLine(l.key, { qty: e.target.value })}
                        aria-label="Quantity" />
                    </td>
                    <td className="narrow">
                      <input type="number" min="0" step="any" value={l.unitPrice}
                        onChange={(e) => setLine(l.key, { unitPrice: e.target.value })}
                        readOnly={l.itemId ? receiptRate(l.itemId) !== null : false}
                        title={l.itemId && receiptRate(l.itemId) !== null
                          ? "Priced by the receipt being returned, so the accrual clears exactly"
                          : undefined}
                        aria-label="Unit price" />
                    </td>
                    <td className="r">{fmt(amount(l))}</td>
                    <td className="tight">
                      <button type="button" className="ghost tiny" onClick={() => removeLine(l.key)}
                        aria-label="Remove line" disabled={lines.length === 1}>×</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="totalbar">
          <span style={{ color: "var(--muted)" }}>Total</span>
          <span className="big">{fmt(total)} MMK</span>
        </div>
      </div>

      {shortages.length > 0 && (
        <div className="alert">
          Not enough stock on hand to return{" "}
          {shortages.map((l) => byId(l.itemId)?.code).join(", ")}. Reduce the quantity.
        </div>
      )}

      <div className="field">
        <label htmlFor="memo">Note</label>
        <textarea id="memo" name="memo" rows={2} placeholder="Reason for the return — English or Myanmar" />
      </div>

      <div className="actions">
        <button type="submit" disabled={pending || total === 0 || shortages.length > 0}>
          {pending ? "Posting…" : `Post ${isSales ? "sales" : "purchase"} return`}
        </button>
        <span className="page-sub">
          {isSales
            ? "Stock returns to inventory; revenue and what the customer owes both reverse."
            : "Stock leaves inventory; what's owed to the supplier drops."}
        </span>
      </div>
    </form>
  );
}
