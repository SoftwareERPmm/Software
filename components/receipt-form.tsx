"use client";

import { useActionState, useEffect, useState } from "react";
import type { ActionResult, PickerItem } from "@/lib/actions";
import { ItemPicker } from "./item-picker";

type Item = PickerItem;
type Node = { id: string; code: string; segment: string; name: string; parent_id: string | null };
type Partner = { id: string; code: string; name: string };
type Location = { id: string; code: string; name: string };
type Line = { key: number; itemId: string; qty: string; unitCost: string };
type MatchLine = { itemId: string; itemCode: string; itemName: string; qty: number; unitPrice: number };
type OpenDoc = { id: string; doc_no: string; doc_date: string; partner_id: string; lines: MatchLine[] };

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

/**
 * Stock arriving with no purchase order behind it — goods that showed up,
 * or a PO placed outside this system. Posts real inventory now, at whatever
 * cost is entered; the supplier's bill is a separate document, whenever it
 * arrives.
 */
export function ReceiptForm({
  action,
  suppliers,
  items: initialItems,
  locations,
  today,
  categories,
  uoms,
  purchaseInvoices,
  initialInvoiceId,
}: {
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  suppliers: Partner[];
  items: Item[];
  locations: Location[];
  today: string;
  categories: Node[];
  uoms: { id: string; code: string; name: string }[];
  /** Open (unmatched) purchase invoices this receipt can match against — the bill arrived first. */
  purchaseInvoices?: OpenDoc[];
  /** Arrived via "Create goods receipt" on a specific invoice's own page — match it immediately. */
  initialInvoiceId?: string;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    action as never,
    null
  );

  const [items, setItems] = useState<Item[]>(initialItems);
  const addItem = (i: Item) => setItems((xs) => [...xs, i]);

  const [lines, setLines] = useState<Line[]>([{ key: 1, itemId: "", qty: "", unitCost: "" }]);
  const [partnerId, setPartnerId] = useState("");
  const [docDate, setDocDate] = useState(today);
  const [receivedTime, setReceivedTime] = useState("");
  const [matchedPiId, setMatchedPiId] = useState("");

  // Set client-side, after mount, so the server-rendered markup and the
  // first client render match — "now" would differ between the two.
  useEffect(() => {
    setReceivedTime(new Date().toTimeString().slice(0, 5));
  }, []);

  const byId = (id: string) => items.find((i) => i.id === id);
  const openInvoices = (purchaseInvoices ?? []).filter((d) => d.partner_id === partnerId);
  const matchedPi = openInvoices.find((d) => d.id === matchedPiId) ?? null;

  function matchInvoice(id: string) {
    setMatchedPiId(id);
    const pi = openInvoices.find((d) => d.id === id);
    if (!pi) return;
    setLines(
      pi.lines.map((l, idx) => ({
        key: idx + 1,
        itemId: l.itemId,
        qty: String(l.qty),
        unitCost: String(l.unitPrice),
      }))
    );
  }

  // Arrived from a specific invoice's own page — its supplier isn't chosen
  // yet at this point, so this searches the full list rather than
  // openInvoices (which only exists once a supplier is picked).
  useEffect(() => {
    if (!initialInvoiceId) return;
    const pi = (purchaseInvoices ?? []).find((d) => d.id === initialInvoiceId);
    if (!pi) return;
    setPartnerId(pi.partner_id);
    setMatchedPiId(pi.id);
    setLines(
      pi.lines.map((l, idx) => ({
        key: idx + 1,
        itemId: l.itemId,
        qty: String(l.qty),
        unitCost: String(l.unitPrice),
      }))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialInvoiceId]);

  function setLine(key: number, patch: Partial<Line>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function pickItem(key: number, itemId: string) {
    const item = byId(itemId);
    const cost = item ? Number(item.next_cost) : 0;
    setLine(key, { itemId, unitCost: cost > 0 ? String(cost) : "" });
  }

  const addLine = () =>
    setLines((ls) => [...ls, { key: Math.max(0, ...ls.map((l) => l.key)) + 1, itemId: "", qty: "", unitCost: "" }]);

  const removeLine = (key: number) =>
    setLines((ls) => (ls.length === 1 ? ls : ls.filter((l) => l.key !== key)));

  const amount = (l: Line) => (Number(l.qty) || 0) * (Number(l.unitCost) || 0);
  const total = lines.reduce((s, l) => s + amount(l), 0);

  const qtyMismatches = matchedPi
    ? lines.filter((l) => {
        const billedLine = matchedPi.lines.find((pl) => pl.itemId === l.itemId);
        return billedLine && Number(l.qty) !== billedLine.qty;
      })
    : [];

  const payload = JSON.stringify(
    lines
      .filter((l) => l.itemId && Number(l.qty) > 0)
      .map((l) => ({ itemId: l.itemId, qty: Number(l.qty), unitCost: Number(l.unitCost) || 0 }))
  );

  return (
    <form action={formAction} className="form wide">
      {state && "error" in state && <div className="alert">{state.error}</div>}

      <input type="hidden" name="lines" value={payload} />

      <div className="card">
        <div className="card-head">
          <h2>Supplier and warehouse</h2>
        </div>
        <div className="card-body">
          <div className="row">
            <div className="field">
              <label htmlFor="partner_id">Supplier</label>
              <select id="partner_id" name="partner_id" value={partnerId}
                onChange={(e) => { setPartnerId(e.target.value); setMatchedPiId(""); }} required>
                <option value="">Choose…</option>
                {suppliers.map((p) => (
                  <option key={p.id} value={p.id}>{p.code} · {p.name}</option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="location_id">Warehouse</label>
              <select id="location_id" name="location_id" defaultValue={locations[0]?.id ?? ""} required>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>{l.code} · {l.name}</option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="doc_date">Received date</label>
              <input id="doc_date" name="doc_date" type="date" value={docDate}
                onChange={(e) => setDocDate(e.target.value)} required />
            </div>

            <div className="field">
              <label htmlFor="received_time">Time</label>
              <input id="received_time" name="received_time" type="time" value={receivedTime}
                onChange={(e) => setReceivedTime(e.target.value)} />
              <span className="hint">Orders same-day receipts correctly for FIFO</span>
            </div>

            <div className="field">
              <label htmlFor="reference">Reference</label>
              <input id="reference" name="reference" type="text" placeholder="Delivery note no." />
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Matching</h2>
        </div>
        <div className="card-body">
          <div className="field">
            <label htmlFor="source_document_id">Match existing supplier invoice</label>
            <select id="source_document_id" name="source_document_id" value={matchedPiId}
              onChange={(e) => matchInvoice(e.target.value)} disabled={!partnerId}>
              {/* The empty option says which of three situations this is.
                  It used to read "no invoice waiting for these goods"
                  whenever nothing was selected — printed directly above a
                  list of the invoices waiting for these goods. */}
              <option value="">
                {!partnerId ? "Choose a supplier first"
                  : openInvoices.length === 0
                    ? "No invoice is waiting for goods from this supplier"
                    : "Not matched — these goods arrive without one"}
              </option>
              {openInvoices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.doc_no} · {String(d.doc_date).slice(0, 10)} · {d.lines.length} line{d.lines.length === 1 ? "" : "s"}
                </option>
              ))}
            </select>
            <span className="hint">
              {matchedPi
                ? "Lines are filled from that invoice — check what actually arrived before posting."
                : openInvoices.length > 0
                  ? `${openInvoices.length} invoice${openInvoices.length === 1 ? " is" : "s are"} `
                    + "waiting on goods from this supplier — billed already, and sitting in "
                    + "GR/IR clearing. Pick the one these goods are for, or leave it unmatched "
                    + "if they are for something else."
                  : partnerId
                    ? "Nothing this supplier has billed is still waiting on goods, so these "
                      + "arrive on their own and the invoice can follow."
                    : "If the supplier billed before the goods came, matching clears GR/IR "
                      + "against that invoice instead of opening a new one."}
            </span>
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
                {matchedPi && <th className="r">Billed</th>}
                <th className="r">Qty</th><th className="r">Unit cost</th>
                <th className="r">Value</th><th />
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const item = byId(l.itemId);
                const billedLine = matchedPi?.lines.find((pl) => pl.itemId === l.itemId);
                const qtyMismatch = matchedPi && billedLine && Number(l.qty) !== billedLine.qty;
                return (
                  <tr key={l.key}>
                    <td style={{ minWidth: 240 }}>
                      <ItemPicker
                        mode="purchase"
                        items={items}
                        categories={categories}
                        uoms={uoms}
                        value={l.itemId}
                        onPick={(id) => pickItem(l.key, id)}
                        onCreated={addItem}
                      />
                    </td>
                    {matchedPi && (
                      <td className="r" style={{ color: qtyMismatch ? "var(--warn)" : undefined }}>
                        {billedLine ? fmt(billedLine.qty) : "—"}
                      </td>
                    )}
                    <td className="narrow">
                      <input type="number" min="0" step="any" value={l.qty}
                        onChange={(e) => setLine(l.key, { qty: e.target.value })}
                        aria-label="Quantity"
                        style={qtyMismatch ? { borderColor: "var(--warn)" } : undefined} />
                    </td>
                    <td className="narrow">
                      <input type="number" min="0" step="any" value={l.unitCost}
                        onChange={(e) => setLine(l.key, { unitCost: e.target.value })}
                        aria-label="Unit cost" />
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
          <span style={{ color: "var(--muted)" }}>Received value</span>
          <span className="big">{fmt(total)} MMK</span>
        </div>
      </div>

      {qtyMismatches.length > 0 && (
        <div className="alert" style={{ borderColor: "var(--warn)", color: "var(--warn)", background: "color-mix(in srgb, var(--warn) 8%, transparent)" }}>
          Received quantity doesn&rsquo;t match what {matchedPi?.doc_no} billed for{" "}
          {qtyMismatches.map((l) => byId(l.itemId)?.code ?? matchedPi?.lines.find((pl) => pl.itemId === l.itemId)?.itemCode).join(", ")}.
          Not blocked — a short shipment can be legitimate — but check before posting.
        </div>
      )}

      <div className="field">
        <label htmlFor="memo">Note</label>
        <textarea id="memo" name="memo" rows={2} placeholder="Optional — English or Myanmar" />
      </div>

      <div className="actions">
        <button type="submit" disabled={pending || total === 0}>
          {pending ? "Posting…" : "Post goods receipt"}
        </button>
        <span className="page-sub">
          Stock arrives now, at this cost — Dr Inventory / Cr GR/IR Clearing.
          Post the supplier&rsquo;s invoice separately whenever it arrives.
        </span>
      </div>
    </form>
  );
}
