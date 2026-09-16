"use client";

import { useMemo, useState } from "react";
import { useActionState } from "react";
import Link from "next/link";
import { Lock } from "lucide-react";
import type { ActionResult } from "@/lib/actions";
import { RelatedDocumentsPanel } from "./related-documents";

type BillLine = {
  lineId: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  uomCode: string | null;
  billedQty: number;
  receivedQty: number;
  remainingQty: number;
  unitPrice: number;
  orderLineId: string | null;
  orderId: string | null;
  orderNo: string | null;
  orderOrdered: number | null;
  orderFulfilled: number | null;
  orderRemaining: number | null;
};

type Bill = {
  id: string; docNo: string; docDate: string;
  partnerId: string; partnerCode: string; partnerName: string;
  locationId: string | null;
  lines: BillLine[];
};

type Location = { id: string; code: string; name: string };

const qty = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 4 });
const money = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

/**
 * Receiving goods against a bill that arrived before them.
 *
 * The bill is chosen before this screen opens, so the screen leads with what
 * it is working on rather than asking again: which bill, which order behind
 * it, which supplier. Changing it is a deliberate second action, not the
 * first field on the form.
 *
 * Two questions are kept apart throughout, because they have different
 * answers and conflating them is what made the old screen misleading. What
 * these goods match on the bill is one; what they allocate to the order is
 * another. Twenty units can match a bill in full and answer only the ten an
 * order still expects, and a screen that prints one figure for both is lying
 * about one of them.
 *
 * The preview is a calculation, not a reading of the link. An order being
 * connected to this bill does not mean every carton arriving answers it —
 * the order may have less left than is being received, or be answered by a
 * different line. So the figures below are worked out from the quantity
 * actually entered, against what each order line still expects, and they are
 * recomputed as that quantity changes. Where a bill names no order the
 * fulfilment rows say so rather than guessing.
 */
export function ReceiveAgainstBill({
  action, bill, locations, today, now, related, backHref, backLabel,
}: {
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  bill: Bill;
  locations: Location[];
  today: string;
  now: string;
  related: React.ReactNode;
  backHref: string;
  backLabel: string;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    action as never, null,
  );
  const [attemptKey] = useState(() => crypto.randomUUID());
  const [locationId, setLocationId] = useState(bill.locationId ?? locations[0]?.id ?? "");
  const [docDate, setDocDate] = useState(today);
  const [time, setTime] = useState(now);
  const [reference, setReference] = useState("");
  const [memo, setMemo] = useState("");

  // Everything still awaited starts filled in: the common case is that what
  // was billed is what turned up.
  const [receiving, setReceiving] = useState<Record<string, string>>(() =>
    Object.fromEntries(bill.lines.map((l) => [l.lineId, String(l.remainingQty)])));

  const entered = (l: BillLine) => Number(receiving[l.lineId]) || 0;
  const unitOf = (l: BillLine) => (l.uomCode ? ` ${l.uomCode}` : "");

  const totals = useMemo(() => {
    let received = 0;
    let value = 0;
    // Per order, worked out line by line: an order takes what it still
    // expects and no more, and the rest of the line answers no order at all.
    const orders = new Map<string, {
      orderNo: string; orderId: string;
      fulfilled: number; ordered: number; allocating: number;
    }>();
    let unallocated = 0;

    for (const l of bill.lines) {
      const q = entered(l);
      if (q <= 0) continue;
      received += q;
      value += q * l.unitPrice;

      if (!l.orderId || !l.orderNo || l.orderRemaining === null) {
        unallocated += q;
        continue;
      }
      const seen = orders.get(l.orderId) ?? {
        orderNo: l.orderNo, orderId: l.orderId,
        fulfilled: l.orderFulfilled ?? 0, ordered: l.orderOrdered ?? 0, allocating: 0,
      };
      // What this order line can still take, less anything earlier lines of
      // this same receipt have already claimed from it.
      const left = Math.max((l.orderRemaining ?? 0) - seen.allocating, 0);
      const takes = Math.min(q, left);
      seen.allocating += takes;
      orders.set(l.orderId, seen);
      unallocated += q - takes;
    }

    return {
      received: Math.round(received * 10000) / 10000,
      value: Math.round(value * 10000) / 10000,
      unallocated: Math.round(unallocated * 10000) / 10000,
      orders: [...orders.values()],
    };
  }, [receiving, bill.lines]);

  const billTotalRemaining = bill.lines.reduce((t, l) => t + l.remainingQty, 0);
  const billFullyReceived = totals.received >= billTotalRemaining - 0.0001;
  const unit = bill.lines[0]?.uomCode ? ` ${bill.lines[0].uomCode}` : "";
  // One unit across the bill, or none named at all: "15 CTN" for ten cartons
  // and five pieces would be a figure that is simply not true.
  const oneUnit = new Set(bill.lines.map((l) => l.uomCode ?? "")).size === 1;

  const payload = JSON.stringify(
    bill.lines
      .filter((l) => entered(l) > 0)
      .map((l) => ({
        itemId: l.itemId,
        qty: entered(l),
        unitCost: l.unitPrice,
        // The bill line these goods answer. The order behind it is reached
        // from here by the engine, which resolves the version that stands —
        // naming it from the browser would freeze a stale one.
        sourceLineId: l.lineId,
      }))
  );

  return (
    <form action={formAction} className="rcv">
      <input type="hidden" name="idempotency_key" value={attemptKey} />
      <input type="hidden" name="partner_id" value={bill.partnerId} />
      <input type="hidden" name="source_document_id" value={bill.id} />
      <input type="hidden" name="lines" value={payload} />

      <div className="page-head">
        <span className="eyebrow">Purchases</span>
        <h1>Receive goods against supplier bill</h1>
        <span className="page-sub">Record only the goods that physically arrived.</span>
      </div>

      {state && "error" in state && <div className="alert">{state.error}</div>}

      <section className="rcv-card rcv-against">
        <div className="rcv-card-head">Receiving against</div>
        <div className="rcv-against-body">
          <div>
            <div className="rcv-k">Supplier bill</div>
            <Link href={`/documents/${bill.id}`}>{bill.docNo}</Link>
          </div>
          <div>
            <div className="rcv-k">Related order</div>
            {orderSummary(bill)}
          </div>
          <div>
            <div className="rcv-k">Supplier</div>
            <span>{bill.partnerCode} · {bill.partnerName}</span>
          </div>
          <Link className="rcv-change" href="/purchases/receive/new">Change bill</Link>
        </div>
      </section>

      <section className="rcv-card">
        <div className="rcv-card-head">Receiving details</div>
        <div className="rcv-fields">
          <div className="field">
            <label htmlFor="rcv_loc">Warehouse</label>
            <select id="rcv_loc" name="location_id" required
                    value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.code} · {l.name}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="rcv_date">Received date</label>
            <input id="rcv_date" name="doc_date" type="date" required
                   value={docDate} onChange={(e) => setDocDate(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="rcv_time">Time</label>
            <input id="rcv_time" name="received_time" type="time"
                   value={time} onChange={(e) => setTime(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="rcv_ref">Delivery reference</label>
            <input id="rcv_ref" name="reference" type="text" placeholder="Delivery note number"
                   value={reference} onChange={(e) => setReference(e.target.value)} />
          </div>
        </div>
      </section>

      <section className="rcv-card">
        <div className="rcv-card-head">Goods received</div>
        <div className="tablewrap">
          <table className="linetable rcv-table">
            <thead>
              <tr>
                <th>Item</th>
                <th className="r">Billed</th>
                <th className="r">Already received against bill</th>
                <th className="r">Remaining</th>
                <th className="r">Receive now <span aria-hidden="true">*</span></th>
                <th className="r">Unit cost</th>
                <th className="r">Value (MMK)</th>
              </tr>
            </thead>
            <tbody>
              {bill.lines.map((l) => (
                <tr key={l.lineId}>
                  <td>
                    <strong>{l.itemCode}</strong>
                    <div className="muted">{l.itemName}</div>
                  </td>
                  <td className="r">{qty(l.billedQty)}{unitOf(l)}</td>
                  <td className="r">{qty(l.receivedQty)}{unitOf(l)}</td>
                  <td className="r">{qty(l.remainingQty)}{unitOf(l)}</td>
                  <td className="r">
                    <span className="rcv-qty">
                      <input type="number" min="0" step="any" required
                             aria-label={`Receive now, ${l.itemCode}`}
                             value={receiving[l.lineId] ?? ""}
                             onChange={(e) => setReceiving((r) =>
                               ({ ...r, [l.lineId]: e.target.value }))} />
                      {l.uomCode && <span className="rcv-uom">{l.uomCode}</span>}
                    </span>
                  </td>
                  <td className="r">
                    {/* The bill decided this. Overtyping it here put the gap
                        between the two in the P&L and carried the stock at a
                        figure nobody owed. */}
                    <span className="rcv-locked" title={`From ${bill.docNo}`}>
                      <Lock size={12} aria-hidden="true" /> {money(l.unitPrice)}
                    </span>
                  </td>
                  <td className="r">{money(entered(l) * l.unitPrice)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="rcv-foot">
          <span className="muted">Unit cost comes from {bill.docNo}.</span>
          <span>
            Received value <strong>{money(totals.value)}</strong> MMK
          </span>
        </div>
      </section>

      <section className="rcv-card">
        <div className="rcv-card-head">Note</div>
        <div style={{ padding: "0.75rem 1rem" }}>
          <textarea name="memo" rows={2} placeholder="Optional — English or Myanmar"
                    value={memo} onChange={(e) => setMemo(e.target.value)} />
        </div>
      </section>

      <section className="rcv-card">
        <div className="rcv-card-head">
          After posting this receipt
        </div>
        <table className="rcv-preview">
          <tbody>
            <tr>
              <th>Received into warehouse</th>
              <td>{oneUnit ? `${qty(totals.received)}${unit}` : perItem(bill, receiving)}</td>
            </tr>
            <tr>
              <th>Matched to supplier bill</th>
              <td>
                <Link href={`/documents/${bill.id}`}>{bill.docNo}</Link>{" · "}
                {oneUnit ? `${qty(totals.received)}${unit}` : perItem(bill, receiving)}
                {billFullyReceived && totals.received > 0 ? " · Fully received" : ""}
              </td>
            </tr>
            {totals.orders.length === 0 ? (
              <tr>
                <th>Allocated to PO</th>
                <td className="muted">No linked order</td>
              </tr>
            ) : totals.orders.map((o) => (
              <tr key={o.orderId}>
                <th>Allocated to {o.orderNo}</th>
                <td>
                  <Link href={`/documents/${o.orderId}`}>{o.orderNo}</Link>{" · "}
                  {qty(o.allocating)}{unit}
                  {" · fulfilment "}
                  {qty(o.fulfilled)} → {qty(o.fulfilled + o.allocating)}
                  {" of "}{qty(o.ordered)}
                </td>
              </tr>
            ))}
            <tr>
              <th>Not allocated to any PO</th>
              <td className={totals.unallocated > 0 ? "" : "muted"}>
                {qty(totals.unallocated)}{oneUnit ? unit : ""}
                {totals.unallocated > 0
                  ? " — received and billed, answering no order"
                  : ""}
              </td>
            </tr>
            <tr>
              <th>Supplier payment</th>
              <td className="muted">Unchanged</td>
            </tr>
          </tbody>
        </table>
      </section>

      {related}

      <div className="rcv-actions">
        <span className="muted">
          Matches the existing bill. No new invoice or payment is created.
        </span>
        <Link className="btn ghost" href={backHref}>{backLabel}</Link>
        <button type="submit" className="btn" disabled={pending || totals.received <= 0}>
          {pending ? "Posting…"
            : `Post goods receipt · ${qty(totals.received)}${oneUnit ? unit : ""}`}
        </button>
      </div>
    </form>
  );
}

/** The orders behind this bill, named rather than counted. */
function orderSummary(bill: Bill) {
  const seen = new Map<string, string>();
  for (const l of bill.lines) if (l.orderId && l.orderNo) seen.set(l.orderId, l.orderNo);
  if (seen.size === 0) return <span className="muted">No linked order</span>;
  return (
    <span>
      {[...seen.entries()].map(([id, no], i) => (
        <span key={id}>
          {i > 0 ? " · " : ""}
          <Link href={`/documents/${id}`}>{no}</Link>
        </span>
      ))}
    </span>
  );
}

/**
 * Quantities per item, where the bill mixes units.
 *
 * Ten cartons and five pieces are not fifteen of anything, and summing them
 * under the first line's unit prints a figure that is simply untrue.
 */
function perItem(bill: Bill, receiving: Record<string, string>) {
  const parts = bill.lines
    .map((l) => ({ l, q: Number(receiving[l.lineId]) || 0 }))
    .filter((x) => x.q > 0)
    .map(({ l, q }) => `${qty(q)}${l.uomCode ? ` ${l.uomCode}` : ""} ${l.itemCode}`);
  return parts.length === 0 ? "—" : parts.join(" · ");
}
