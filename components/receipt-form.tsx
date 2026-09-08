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
/** Not an invoice id, so it cannot collide with one. */
const NONE = "__none__";

const shortDate = (v: unknown) =>
  v ? new Date(String(v)).toLocaleDateString("en-GB",
    { weekday: "short", day: "numeric", month: "short" }) : "";

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
  // Chose "not matched" deliberately, as opposed to not having answered yet.
  // Only distinguishable while more than one invoice is waiting; with one it
  // is picked for you and this is how you say no to it.
  const [unmatched, setUnmatched] = useState(false);
  const [autoMatched, setAutoMatched] = useState(false);

  // Set client-side, after mount, so the server-rendered markup and the
  // first client render match — "now" would differ between the two.
  useEffect(() => {
    setReceivedTime(new Date().toTimeString().slice(0, 5));
  }, []);

  const byId = (id: string) => items.find((i) => i.id === id);
  const openInvoices = (purchaseInvoices ?? []).filter((d) => d.partner_id === partnerId);
  const matchedPi = openInvoices.find((d) => d.id === matchedPiId) ?? null;

  function fillFrom(pi: OpenDoc) {
    setLines(
      pi.lines.map((l, idx) => ({
        key: idx + 1,
        itemId: l.itemId,
        qty: String(l.qty),
        unitCost: String(l.unitPrice),
      }))
    );
  }

  function matchInvoice(id: string, auto = false) {
    setMatchedPiId(id);
    setUnmatched(false);
    setAutoMatched(auto);
    const pi = openInvoices.find((d) => d.id === id);
    if (pi) fillFrom(pi);
  }

  /**
   * Stop matching — either the supplier changed, or these goods really are
   * arriving without an invoice. Lines that came from an invoice go with it:
   * leaving another supplier's items sitting in the table is how a receipt
   * gets posted for goods nobody sent.
   */
  function clearMatch(hadMatch: boolean) {
    setMatchedPiId("");
    setAutoMatched(false);
    if (hadMatch) setLines([{ key: 1, itemId: "", qty: "", unitCost: "" }]);
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

  /**
   * One invoice waiting on goods from this supplier is not a question.
   *
   * The form used to open on "Not matched", printed directly above a list
   * containing the very invoice these goods were for, and wait to be told
   * what it already knew. Two invoices is a real question and is still
   * asked; one is answered.
   */
  useEffect(() => {
    if (initialInvoiceId) return;
    if (!partnerId) return;
    if (matchedPiId && openInvoices.some((d) => d.id === matchedPiId)) return;
    const hadMatch = matchedPiId !== "";
    if (openInvoices.length === 1) matchInvoice(openInvoices[0].id, true);
    else { clearMatch(hadMatch); setUnmatched(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partnerId, purchaseInvoices]);

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

  // A line with goods on it and nothing in the cost column. It posts — a
  // supplier's free sample really does arrive at nothing — but it puts stock
  // on the shelf that the balance sheet says is worth nothing, and the FIFO
  // layer it creates will charge a later sale nothing for it. Worth saying
  // out loud rather than discovering in a margin report.
  const freeLines = lines.filter(
    (l) => l.itemId && Number(l.qty) > 0 && !(Number(l.unitCost) > 0));

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
                onChange={(e) => {
                  // Their invoice, and the lines it filled in, belong to the
                  // old supplier. Both go.
                  clearMatch(matchedPiId !== "");
                  setUnmatched(false);
                  setPartnerId(e.target.value);
                }} required>
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
            <input type="hidden" name="source_document_id" value={matchedPiId} />
            <select id="source_document_id"
              value={matchedPiId || (unmatched ? NONE : "")}
              onChange={(e) => {
                if (e.target.value === NONE) {
                  clearMatch(matchedPiId !== "");
                  setUnmatched(true);
                } else if (e.target.value) {
                  matchInvoice(e.target.value);
                } else {
                  clearMatch(matchedPiId !== "");
                }
              }}
              disabled={!partnerId}>
              {/* An unanswered option only where there is a question. With no
                  supplier, or none of theirs waiting, it says which of those
                  it is; with several waiting it asks. With one waiting there
                  is nothing to ask, so the invoice itself is what shows, and
                  arriving without one moves to the bottom where a deliberate
                  answer belongs. */}
              {!partnerId && <option value="">Choose a supplier first</option>}
              {partnerId && openInvoices.length === 0 && (
                <option value="">No invoice is waiting for goods from this supplier</option>
              )}
              {partnerId && openInvoices.length > 1 && !matchedPiId && !unmatched && (
                <option value="">Which invoice are these goods for?</option>
              )}
              {openInvoices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.doc_no} · {shortDate(d.doc_date)} · {d.lines.length} line{d.lines.length === 1 ? "" : "s"}
                </option>
              ))}
              {partnerId && openInvoices.length > 0 && (
                <option value={NONE}>Not matched — these goods arrive without an invoice</option>
              )}
            </select>
            <span className="hint">
              {matchedPi
                ? autoMatched
                  ? `${matchedPi.doc_no} is the only invoice waiting on goods from this `
                    + "supplier, so it is matched and its lines are filled in. Check what "
                    + "actually arrived, or choose \u201cnot matched\u201d if these goods are "
                    + "for something else."
                  : "Lines are filled from that invoice — check what actually arrived before posting."
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
          <span className="actions">
            {matchedPi && (
              <span className="page-sub">
                filled from {matchedPi.doc_no}
              </span>
            )}
            <button type="button" className="ghost tiny" onClick={addLine}>Add line</button>
          </span>
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

      {freeLines.length > 0 && (
        <div className="alert" style={{ marginBottom: "0.75rem" }}>
          <strong>
            {freeLines.length === 1 ? "One line has" : `${freeLines.length} lines have`} a
            quantity but no unit cost.
          </strong>{" "}
          {freeLines.map((l) => byId(l.itemId)?.code).filter(Boolean).join(", ")} would
          arrive worth nothing, and a later sale would draw them at nothing.
          {matchedPi
            ? " The matched invoice carries the prices — reselect it to fill them in."
            : openInvoices.length > 0
              ? " If the supplier already billed for these, matching that invoice fills in what they cost."
              : " Enter what they cost, or post it deliberately if they really were free."}
        </div>
      )}

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
