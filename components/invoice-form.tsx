"use client";

import { useActionState, useEffect, useState } from "react";
import type { ActionResult, PickerItem } from "@/lib/actions";
import { ItemPicker } from "./item-picker";

type Item = PickerItem;
type Node = { id: string; code: string; segment: string; name: string; parent_id: string | null };

type Partner = { id: string; code: string; name: string; payment_terms_days: number };
type Location = { id: string; code: string; name: string };
type CashAccount = { id: string; code: string; name: string };
type MatchLine = { lineId: string; itemId: string; itemCode: string; itemName: string; qty: number; unitPrice: number };
type OpenDoc = {
  id: string; doc_no: string; doc_date: string; partner_id: string;
  /** The purchase order this receipt came in against, when it came from one. */
  source_no?: string | null;
  lines: MatchLine[];
};

// sourceLineId is set only when the line was prefilled from a goods receipt.
// It is what lets GR/IR be settled at the rate that particular line came in
// at, rather than at an average across every line of the same item.
type Line = { key: number; itemId: string; qty: string; unitPrice: string; sourceLineId?: string };

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

function addDays(iso: string, days: number) {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export function InvoiceForm({
  kind,
  action,
  partners,
  items: initialItems,
  locations,
  today,
  categories,
  uoms,
  cashAccounts,
  goodsReceipts,
  initialGoodsReceiptId,
}: {
  kind: "sales" | "purchase";
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  partners: Partner[];
  items: Item[];
  locations: Location[];
  today: string;
  categories: Node[];
  uoms: { id: string; code: string; name: string }[];
  cashAccounts?: CashAccount[];
  /** Open (unmatched) goods receipts this invoice can match against — purchase only. */
  goodsReceipts?: OpenDoc[];
  /** Arrived via "Create purchase invoice" on a specific receipt's own page — match it immediately. */
  initialGoodsReceiptId?: string;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    action as never,
    null
  );

  const [items, setItems] = useState<Item[]>(initialItems);
  const addItem = (i: Item) => setItems((xs) => [...xs, i]);

  const [lines, setLines] = useState<Line[]>([{ key: 1, itemId: "", qty: "", unitPrice: "" }]);
  const [partnerId, setPartnerId] = useState("");
  const [docDate, setDocDate] = useState(today);
  const [dueDate, setDueDate] = useState("");
  const [cashOut, setCashOut] = useState("");
  const [cashAccountId, setCashAccountId] = useState("");
  const [matchedGrId, setMatchedGrId] = useState("");
  const [reference, setReference] = useState("");

  const isSales = kind === "sales";
  const byId = (id: string) => items.find((i) => i.id === id);
  const openReceipts = (goodsReceipts ?? []).filter((d) => d.partner_id === partnerId);
  const matchedGr = openReceipts.find((d) => d.id === matchedGrId) ?? null;

  /**
   * Our own number for the job this bill belongs to — the purchase order it
   * traces back to, or the receipt itself when it came in without one.
   *
   * Filled in rather than left blank because stepping order → receipt →
   * invoice already knows the answer, and making someone copy it across from
   * another screen is how a bill ends up with no order on it at all. It stays
   * an ordinary input: the supplier's own invoice number can be typed over it.
   */
  const referenceFor = (d: OpenDoc) => d.source_no || d.doc_no;

  function matchGoodsReceipt(id: string) {
    setMatchedGrId(id);
    const gr = openReceipts.find((d) => d.id === id);
    if (!gr) return;
    setLines(
      gr.lines.map((l, idx) => ({
        key: idx + 1,
        itemId: l.itemId,
        qty: String(l.qty),
        unitPrice: String(l.unitPrice),
        sourceLineId: l.lineId,
      }))
    );
  }

  // Arrived from a specific receipt's own page — its supplier isn't chosen
  // yet at this point, so this searches the full list rather than
  // openReceipts (which only exists once a supplier is picked).
  useEffect(() => {
    if (!initialGoodsReceiptId) return;
    const gr = (goodsReceipts ?? []).find((d) => d.id === initialGoodsReceiptId);
    if (!gr) return;
    setPartnerId(gr.partner_id);
    setMatchedGrId(gr.id);
    // Only when the invoice was opened from a receipt — walking the chain is
    // what makes the order relevant. Someone who opened a blank invoice and
    // chose a receipt from the list is composing it themselves.
    setReference(referenceFor(gr));
    setLines(
      gr.lines.map((l, idx) => ({
        key: idx + 1,
        itemId: l.itemId,
        qty: String(l.qty),
        unitPrice: String(l.unitPrice),
        sourceLineId: l.lineId,
      }))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialGoodsReceiptId]);

  function setLine(key: number, patch: Partial<Line>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function pickItem(key: number, itemId: string) {
    const item = byId(itemId);
    const price = !item ? "" : isSales ? item.sale_price : item.next_cost;
    // Changing the item detaches the line from the receipt line it was
    // prefilled from — that reference belonged to the old item.
    setLine(key, {
      itemId,
      unitPrice: Number(price) > 0 ? String(Number(price)) : "",
      sourceLineId: undefined,
    });
  }

  function pickPartner(id: string) {
    setPartnerId(id);
    setMatchedGrId("");
    const p = partners.find((x) => x.id === id);
    if (p && p.payment_terms_days > 0) setDueDate(addDays(docDate, p.payment_terms_days));
  }

  const addLine = () =>
    setLines((ls) => [...ls, { key: Math.max(0, ...ls.map((l) => l.key)) + 1, itemId: "", qty: "", unitPrice: "" }]);

  const removeLine = (key: number) =>
    setLines((ls) => (ls.length === 1 ? ls : ls.filter((l) => l.key !== key)));

  const amount = (l: Line) => (Number(l.qty) || 0) * (Number(l.unitPrice) || 0);
  const total = lines.reduce((s, l) => s + amount(l), 0);

  const payload = JSON.stringify(
    lines
      .filter((l) => l.itemId && Number(l.qty) > 0)
      .map((l) => ({
        itemId: l.itemId,
        qty: Number(l.qty),
        unitPrice: Number(l.unitPrice) || 0,
        sourceLineId: l.sourceLineId,
      }))
  );

  // Warn before submitting rather than after the server rejects it.
  const shortages = lines.filter((l) => {
    if (!isSales || !l.itemId) return false;
    const item = byId(l.itemId);
    return item?.is_stocked && Number(l.qty) > Number(item.on_hand);
  });

  const qtyMismatches = matchedGr
    ? lines.filter((l) => {
        const receivedLine = matchedGr.lines.find((gl) => gl.itemId === l.itemId);
        return receivedLine && Number(l.qty) !== receivedLine.qty;
      })
    : [];

  const cashOverpaid = !isSales && Number(cashOut) > total;
  const leavesBalance = !isSales && Number(cashOut) < total;

  return (
    <form action={formAction} className="form wide">
      {state && "error" in state && <div className="alert">{state.error}</div>}

      <input type="hidden" name="lines" value={payload} />

      <div className="card">
        <div className="card-head">
          <h2>{isSales ? "Customer" : "Supplier"} and dates</h2>
        </div>
        <div className="card-body">
          <div className="row">
            <div className="field">
              <label htmlFor="partner_id">{isSales ? "Customer" : "Supplier"}</label>
              <select
                id="partner_id"
                name="partner_id"
                value={partnerId}
                onChange={(e) => pickPartner(e.target.value)}
                required
              >
                <option value="">Choose…</option>
                {partners.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} · {p.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="location_id">Warehouse</label>
              <select id="location_id" name="location_id" defaultValue={locations[0]?.id ?? ""} required>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.code} · {l.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="doc_date">Invoice date</label>
              <input
                id="doc_date"
                name="doc_date"
                type="date"
                value={docDate}
                onChange={(e) => setDocDate(e.target.value)}
                required
              />
            </div>

            <div className="field">
              <label htmlFor="due_date">Due date</label>
              <input
                id="due_date"
                name="due_date"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                required={leavesBalance}
              />
              <span className="hint">
                {leavesBalance ? "Filled from payment terms — required so this can be tracked as overdue" : "Filled from payment terms"}
              </span>
            </div>
          </div>
        </div>
      </div>

      {!isSales && (
        <div className="card">
          <div className="card-head">
            <h2>Matching</h2>
          </div>
          <div className="card-body">
            <div className="field">
              <label htmlFor="goods_receipt_id">Match existing goods receipt</label>
              <select id="goods_receipt_id" name="goods_receipt_id" value={matchedGrId}
                onChange={(e) => matchGoodsReceipt(e.target.value)} disabled={!partnerId}>
                <option value="">
                  {partnerId ? "Not matched — new receipt or bill first" : "Choose a supplier first"}
                </option>
                {openReceipts.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.doc_no} · {String(d.doc_date).slice(0, 10)} · {d.lines.length} line{d.lines.length === 1 ? "" : "s"}
                  </option>
                ))}
              </select>
              <span className="hint">
                {matchedGr
                  ? "Lines are filled from this receipt — check quantities and prices against the actual bill before posting."
                  : "The goods are already in the warehouse and just need their bill recorded — pick which receipt this invoice is for."}
              </span>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2>Lines</h2>
          <button type="button" className="ghost tiny" onClick={addLine}>
            Add line
          </button>
        </div>

        <div className="tablewrap">
          <table className="linetable">
            <thead>
              <tr>
                <th>Item</th>
                <th className="r">{isSales ? "On hand" : "Next cost"}</th>
                {matchedGr && <th className="r">Received</th>}
                <th className="r">Qty</th>
                <th className="r">Unit price</th>
                <th className="r">Amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const item = byId(l.itemId);
                const short = isSales && item?.is_stocked && Number(l.qty) > Number(item.on_hand);
                const receivedLine = matchedGr?.lines.find((gl) => gl.itemId === l.itemId);
                const qtyMismatch = matchedGr && receivedLine && Number(l.qty) !== receivedLine.qty;

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
                        <span style={{ color: short ? "var(--bad)" : undefined }}>
                          {item.is_stocked ? fmt(Number(item.on_hand)) : "service"}
                        </span>
                      ) : (
                        fmt(Number(item.next_cost))
                      )}
                    </td>
                    {matchedGr && (
                      <td className="r" style={{ color: qtyMismatch ? "var(--warn)" : undefined }}>
                        {receivedLine ? fmt(receivedLine.qty) : "—"}
                      </td>
                    )}
                    <td className="narrow">
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={l.qty}
                        onChange={(e) => setLine(l.key, { qty: e.target.value })}
                        aria-label="Quantity"
                        style={qtyMismatch ? { borderColor: "var(--warn)" } : undefined}
                      />
                    </td>
                    <td className="narrow">
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={l.unitPrice}
                        onChange={(e) => setLine(l.key, { unitPrice: e.target.value })}
                        aria-label="Unit price"
                      />
                    </td>
                    <td className="r">{fmt(amount(l))}</td>
                    <td className="tight">
                      <button
                        type="button"
                        className="ghost tiny"
                        onClick={() => removeLine(l.key)}
                        aria-label="Remove line"
                        disabled={lines.length === 1}
                      >
                        ×
                      </button>
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
          Not enough stock for{" "}
          {shortages.map((l) => byId(l.itemId)?.code).join(", ")}. Posting will be
          rejected — reduce the quantity or receive stock first.
        </div>
      )}

      {qtyMismatches.length > 0 && (
        <div className="alert" style={{ borderColor: "var(--warn)", color: "var(--warn)", background: "color-mix(in srgb, var(--warn) 8%, transparent)" }}>
          Billed quantity doesn&rsquo;t match what {matchedGr?.doc_no} recorded as received for{" "}
          {qtyMismatches.map((l) => byId(l.itemId)?.code ?? matchedGr?.lines.find((gl) => gl.itemId === l.itemId)?.itemCode).join(", ")}.
          Not blocked — a partial delivery or short shipment can be legitimate — but check before posting.
        </div>
      )}

      {!isSales && !matchedGrId && (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.65rem", marginTop: "0.5rem" }}>
          <label className="check" htmlFor="received_now">
            <input id="received_now" name="received_now" type="checkbox" defaultChecked />
            Received now — goods are already in the warehouse
          </label>
          <span className="hint">
            Checked: a goods receipt posts alongside the bill, now. Unchecked:
            only the payable side posts — the goods haven&rsquo;t arrived yet,
            so receive them later from Purchases → Goods receipts.
          </span>
        </div>
      )}

      {!isSales && (
        <div className="card" style={{ marginTop: "0.5rem" }}>
          <div className="card-head">
            <h2>Paid now</h2>
          </div>
          <div className="card-body">
            <div className="row">
              <div className="field">
                <label htmlFor="cash_out">Amount paid</label>
                <input id="cash_out" name="cash_out" type="number" min="0" step="any"
                  value={cashOut} onChange={(e) => setCashOut(e.target.value)}
                  placeholder="0" />
                <span className="hint">Leave blank for a fully credit purchase</span>
              </div>

              <div className="field">
                <label htmlFor="cash_account_id">Paid from</label>
                <select id="cash_account_id" name="cash_account_id" value={cashAccountId}
                  onChange={(e) => setCashAccountId(e.target.value)}
                  disabled={!Number(cashOut)}>
                  <option value="">Choose…</option>
                  {(cashAccounts ?? []).map((a) => (
                    <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                  ))}
                </select>
              </div>
            </div>
            {cashOverpaid && (
              <div className="alert" style={{ marginTop: "0.5rem" }}>
                Amount paid can&rsquo;t be more than the invoice total ({fmt(total)} MMK).
              </div>
            )}
          </div>
        </div>
      )}

      <div className="row">
        <div className="field">
          <label htmlFor="reference">Ref / order ID</label>
          <input id="reference" name="reference" type="text"
                 value={reference} onChange={(e) => setReference(e.target.value)}
                 placeholder={isSales ? "Sales order or customer PO" : "Purchase order or supplier invoice no"} />
          {initialGoodsReceiptId && reference && (
            <span className="hint">
              The order this {isSales ? "delivery" : "receipt"} came from. Type over it for the
              {isSales ? " customer's" : " supplier's"} own number.
            </span>
          )}
        </div>
      </div>

      <div className="field">
        <label htmlFor="memo">Note</label>
        <textarea id="memo" name="memo" rows={2} placeholder="Optional — English or Myanmar" />
      </div>

      <div className="actions">
        <button type="submit"
          disabled={pending || total === 0 || shortages.length > 0 || cashOverpaid || (Number(cashOut) > 0 && !cashAccountId)}>
          {pending ? "Posting…" : `Post ${isSales ? "sales" : "purchase"} invoice`}
        </button>
        <span className="page-sub">
          Posting writes the stock movement and the journal entry together, or neither.
        </span>
      </div>
    </form>
  );
}
