"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import type { ActionResult } from "@/lib/actions";

type Line = {
  lineId: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  remainingQty: number;
  expectedPrice?: number;
};
type StockRow = { item_id: string; location_id: string; qty_on_hand: string };

/**
 * One order as a card: collapsed shows just the header and a Deliver/Receive
 * button; expanded shows every open line with an editable quantity — and
 * cost, on the purchase side — defaulting to the full remainder, since
 * fulfilling in one go is the common case.
 */
export function FulfillOrderForm({
  kind,
  orderId,
  orderNo,
  partnerName,
  partnerId,
  locationId,
  lines,
  action,
  stockByLocation,
}: {
  kind: "sales" | "purchase";
  orderId: string;
  orderNo: string;
  partnerName: string;
  partnerId: string;
  locationId: string;
  lines: Line[];
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  /** On-hand per item/location, checked against what's being delivered — receiving isn't limited by it, so purchase call sites can leave this out. */
  stockByLocation?: StockRow[];
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    action as never,
    null
  );
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState<Record<string, string>>(
    Object.fromEntries(lines.map((l) => [l.lineId, String(l.remainingQty)]))
  );
  const [cost, setCost] = useState<Record<string, string>>(
    Object.fromEntries(lines.map((l) => [l.lineId, String(l.expectedPrice ?? 0)]))
  );

  const onHandHere = (itemId: string) =>
    Number(stockByLocation?.find((r) => r.item_id === itemId && r.location_id === locationId)?.qty_on_hand ?? 0);
  // Sum across every location, not just this one — a transfer can only ever
  // move stock the company already has; it can't cover a line short even
  // once every warehouse is counted, only purchasing more can.
  const onHandAnywhere = (itemId: string) =>
    (stockByLocation ?? [])
      .filter((r) => r.item_id === itemId)
      .reduce((s, r) => s + Number(r.qty_on_hand), 0);

  const shortages = kind === "sales" && stockByLocation
    ? lines.filter((l) => Number(qty[l.lineId]) > onHandHere(l.itemId))
    : [];
  const shortEverywhere = shortages.filter((l) => Number(qty[l.lineId]) > onHandAnywhere(l.itemId));

  const payload = JSON.stringify(
    lines
      .filter((l) => Number(qty[l.lineId]) > 0)
      .map((l) => ({
        itemId: l.itemId,
        qty: Number(qty[l.lineId]),
        unitCost: kind === "purchase" ? Number(cost[l.lineId]) || 0 : undefined,
        sourceLineId: l.lineId,
      }))
  );

  return (
    <div className="card">
      <div className="card-head">
        <h2>
          <Link href={`/documents/${orderId}`} style={{ color: "var(--brand)" }}>{orderNo}</Link>
          {" · "}{partnerName}
        </h2>
        <span className="actions">
          <span className="page-sub">{lines.length} line{lines.length === 1 ? "" : "s"} open</span>
          <button type="button" className="ghost tiny" onClick={() => setOpen((v) => !v)}>
            {open ? "Cancel" : kind === "sales" ? "Deliver" : "Receive"}
          </button>
        </span>
      </div>

      {open && (
        <div className="card-body">
          <form action={formAction} className="form">
            {state && "error" in state && <div className="alert">{state.error}</div>}
            <input type="hidden" name="partner_id" value={partnerId} />
            <input type="hidden" name="location_id" value={locationId} />
            <input type="hidden" name="source_document_id" value={orderId} />
            <input type="hidden" name="doc_date" value={new Date().toISOString().slice(0, 10)} />
            <input type="hidden" name="reference" value={`Against ${orderNo}`} />
            <input type="hidden" name="lines" value={payload} />

            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Item</th><th className="r">Remaining</th>
                    {stockByLocation && kind === "sales" && <th className="r">Available here</th>}
                    <th className="r">{kind === "sales" ? "Deliver now" : "Receive now"}</th>
                    {kind === "purchase" && <th className="r">Unit cost</th>}
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => {
                    const short = kind === "sales" && stockByLocation && Number(qty[l.lineId]) > onHandHere(l.itemId);
                    return (
                      <tr key={l.lineId}>
                        <td className="wrap"><span className="code">{l.itemCode}</span> {l.itemName}</td>
                        <td className="r">{l.remainingQty}</td>
                        {stockByLocation && kind === "sales" && (
                          <td className="r" style={{ color: short ? "var(--bad)" : undefined }}>
                            {onHandHere(l.itemId)}
                          </td>
                        )}
                        <td className="narrow">
                          <input
                            type="number" min="0" max={l.remainingQty} step="any"
                            value={qty[l.lineId]}
                            style={short ? { borderColor: "var(--bad)" } : undefined}
                            onChange={(e) => setQty((q) => ({ ...q, [l.lineId]: e.target.value }))}
                          />
                        </td>
                        {kind === "purchase" && (
                          <td className="narrow">
                            <input
                              type="number" min="0" step="any"
                              value={cost[l.lineId]}
                              onChange={(e) => setCost((c) => ({ ...c, [l.lineId]: e.target.value }))}
                            />
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {kind === "sales" && (
              <div className="field" style={{ maxWidth: 300, marginTop: "0.6rem" }}>
                <label htmlFor={`delivery_fee_${orderId}`}>Delivery fee</label>
                <input id={`delivery_fee_${orderId}`} name="delivery_fee"
                       type="number" min="0" step="0.01" placeholder="0" />
                <span className="hint">
                  Charged for carrying these goods. Recorded here and billed on the
                  invoice for this delivery — it posts to delivery income there, not
                  when the goods leave.
                </span>
              </div>
            )}

            {shortEverywhere.length > 0 && (
              <div className="alert">
                The company doesn&rsquo;t have enough {shortEverywhere.map((l) => l.itemCode).join(", ")} anywhere —
                transferring stock in can&rsquo;t cover this, only buying more can.{" "}
                <Link href="/purchases/orders/new" style={{ color: "inherit", textDecoration: "underline" }}>
                  Create purchase order
                </Link>{" "}
                first, or lower the quantity to what the company actually has.
              </div>
            )}
            {shortages.length > shortEverywhere.length && (
              <div className="alert">
                Not enough {shortages.filter((l) => !shortEverywhere.includes(l)).map((l) => l.itemCode).join(", ")}
                {" "}at this location to deliver that much, though the company has it elsewhere.{" "}
                <Link href="/inventory/transfer" style={{ color: "inherit", textDecoration: "underline" }}>
                  Transfer stock in
                </Link>{" "}
                first, or lower the quantity to what&rsquo;s available here.
              </div>
            )}

            <div className="actions" style={{ marginTop: "0.5rem" }}>
              <button type="submit" disabled={pending || shortages.length > 0}>
                {pending ? "Posting…" : kind === "sales" ? "Post delivery" : "Post goods receipt"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
