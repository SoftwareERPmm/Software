"use client";

import { useActionState, useState } from "react";
import type { ActionResult } from "@/lib/actions";

type AgreementLine = {
  lineId: string; itemId: string; itemCode: string; itemName: string;
  pricingMethod: "PERCENTAGE" | "FIXED"; pricingValue: number; isActive: boolean;
};
type Agreement = {
  id: string; partnerId: string; partnerCode: string; partnerName: string;
  lines: AgreementLine[];
};
type Line = {
  itemId: string;
  /** Blank for an item not yet on the agreement — its terms come with it. */
  agreementLineId: string;
  qty: string;
  itemCode: string; itemName: string;
  pricingMethod: "PERCENTAGE" | "FIXED";
  pricingValue: string;
};
type Item = { id: string; code: string; name: string; is_stocked?: boolean };

const basis = (l: AgreementLine) =>
  l.pricingMethod === "PERCENTAGE" ? `${l.pricingValue}% of selling price` : `Fixed ${l.pricingValue}/unit`;

export function ConsignmentReceiveForm({
  agreements, locations, today, action, items = [],
}: {
  agreements: Agreement[];
  locations: { id: string; code: string; name: string }[];
  today: string;
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  /** Everything stocked, so a consignor can send something the agreement has
   *  not named yet. An agreement that must be complete before the first
   *  shipment describes a negotiation that has finished, and they do not. */
  items?: Item[];
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(action as never, null);
  const [agreementId, setAgreementId] = useState("");
  const [locationId, setLocationId] = useState(locations[0]?.id ?? "");
  const [docDate, setDocDate] = useState(today);
  const [lines, setLines] = useState<Line[]>([]);

  const agreement = agreements.find((a) => a.id === agreementId) ?? null;
  const available = (agreement?.lines ?? []).filter((l) => l.isActive
    && !lines.some((x) => x.agreementLineId === l.lineId));

  const addLine = (al: AgreementLine) =>
    setLines((ls) => [...ls, {
      itemId: al.itemId, agreementLineId: al.lineId, qty: "",
      itemCode: al.itemCode, itemName: al.itemName,
      pricingMethod: al.pricingMethod, pricingValue: String(al.pricingValue),
    }]);
  const removeLine = (itemId: string) =>
    setLines((ls) => ls.filter((l) => l.itemId !== itemId));
  const setLine = (itemId: string, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.itemId === itemId ? { ...l, ...patch } : l)));

  // An item this consignor has not sent before. Its terms are agreed here and
  // go on the agreement as the shipment is received.
  const newItems = items.filter((i) =>
    i.is_stocked !== false
    && !(agreement?.lines ?? []).some((l) => l.itemId === i.id && l.isActive)
    && !lines.some((l) => l.itemId === i.id));
  const addNewItem = (i: Item) =>
    setLines((ls) => [...ls, {
      itemId: i.id, agreementLineId: "", qty: "",
      itemCode: i.code, itemName: i.name,
      pricingMethod: "PERCENTAGE", pricingValue: "",
    }]);

  const payload = JSON.stringify(
    lines.filter((l) => Number(l.qty) > 0).map((l) => ({
      itemId: l.itemId, agreementLineId: l.agreementLineId || null, qty: Number(l.qty),
      pricingMethod: l.agreementLineId ? null : l.pricingMethod,
      pricingValue: l.agreementLineId ? null : Number(l.pricingValue) || 0,
    }))
  );

  return (
    <form action={formAction} data-density="odoo">
      <input type="hidden" name="lines" value={payload} />
      <div className="erp-sheet-page" style={{ maxWidth: 720 }}>
        <div className="erp-doc-title"><h1 style={{ fontSize: "var(--t-xl)" }}>Receive Consignment</h1></div>

        <div className="erp-fields">
          <div>
            <label style={{ display: "block", fontSize: "var(--erp-text-sm)", color: "var(--erp-fg-muted)" }}>
              Consignor
            </label>
            <select name="partner_id" value={agreement?.partnerId ?? ""} required
                    onChange={(e) => {
                      const ag = agreements.find((a) => a.partnerId === e.target.value);
                      setAgreementId(ag?.id ?? "");
                      setLines([]);
                    }}>
              <option value="">Choose a consignor…</option>
              {agreements.map((a) => <option key={a.id} value={a.partnerId}>{a.partnerCode} · {a.partnerName}</option>)}
            </select>
            {agreements.length === 0 && (
              <div style={{ color: "var(--warn)", fontSize: "var(--erp-text-sm)", marginTop: "0.3rem" }}>
                No consignment agreements exist yet — create one first.
              </div>
            )}
          </div>
          <div>
            <label style={{ display: "block", fontSize: "var(--erp-text-sm)", color: "var(--erp-fg-muted)" }}>
              Warehouse
            </label>
            <select name="location_id" value={locationId} onChange={(e) => setLocationId(e.target.value)} required>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.code} · {l.name}</option>)}
            </select>
          </div>
          <div>
            <label style={{ display: "block", fontSize: "var(--erp-text-sm)", color: "var(--erp-fg-muted)" }}>Date</label>
            <input name="doc_date" type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)} required />
          </div>
        </div>

        {!agreement && agreements.length > 0 && (
          <div style={{ color: "var(--erp-fg-muted)", padding: "0.8rem 0" }}>
            Choose a consignor to list what they have sent and how many of each
            arrived.
          </div>
        )}

        {agreement && (
          <>
            <div className="erp-tabs"><span className="erp-tab here">Items</span></div>
            <table className="erp-table">
              <thead>
                <tr>
                  <th className="erp-th">Item</th>
                  <th className="erp-th">Settlement basis</th>
                  <th className="erp-th erp-num">Quantity</th>
                  <th className="erp-th" />
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.itemId} className="erp-tr">
                    <td className="erp-td">
                      <span className="erp-item-code">{line.itemCode}</span>{line.itemName}
                    </td>
                    <td className="erp-td" style={{ color: "var(--erp-fg-muted)" }}>
                      {line.agreementLineId ? (
                        line.pricingMethod === "PERCENTAGE"
                          ? `${line.pricingValue}% of selling price`
                          : `Fixed ${line.pricingValue}/unit`
                      ) : (
                        /* New to this agreement, so the terms are set here and
                           go on file as the shipment is received. */
                        <span style={{ display: "inline-flex", gap: "0.35rem", alignItems: "center" }}>
                          <select value={line.pricingMethod}
                                  onChange={(e) => setLine(line.itemId, {
                                    pricingMethod: e.target.value as "PERCENTAGE" | "FIXED" })}>
                            <option value="PERCENTAGE">% of selling price</option>
                            <option value="FIXED">Fixed per unit</option>
                          </select>
                          <input type="number" min="0" step="0.01" value={line.pricingValue}
                                 placeholder={line.pricingMethod === "PERCENTAGE" ? "70" : "0"}
                                 onChange={(e) => setLine(line.itemId, { pricingValue: e.target.value })}
                                 style={{ width: 90, textAlign: "right" }} />
                          <span className="pill warn">new</span>
                        </span>
                      )}
                    </td>
                    <td className="erp-td erp-num">
                      <input type="number" min="0" step="0.01" value={line.qty}
                             onChange={(e) => setLine(line.itemId, { qty: e.target.value })}
                             style={{ width: 100, textAlign: "right" }} />
                    </td>
                    <td className="erp-td">
                      <button type="button" className="erp-btn"
                              onClick={() => removeLine(line.itemId)}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {lines.length === 0 && (
              <div className="erp-td" style={{ color: "var(--erp-fg-muted)", padding: "0.8rem 0" }}>
                {agreement.lines.some((l) => l.isActive)
                  ? "Add the items in this shipment, then enter how many of each arrived."
                  : "This agreement does not name any items yet. Add what the consignor "
                    + "has sent and agree what it settles at — it goes on the agreement "
                    + "as the shipment is received."}
              </div>
            )}

            <div style={{ display: "flex", gap: "0.5rem", padding: "0.6rem 0", flexWrap: "wrap" }}>
              {available.length > 0 && (
                <select onChange={(e) => {
                  const al = available.find((l) => l.lineId === e.target.value);
                  if (al) addLine(al);
                  e.target.value = "";
                }} defaultValue="">
                  <option value="" disabled>+ On the agreement…</option>
                  {available.map((l) => (
                    <option key={l.lineId} value={l.lineId}>{l.itemCode} · {l.itemName} — {basis(l)}</option>
                  ))}
                </select>
              )}
              {/* Anything else the consignor sent. Without this the form was a
                  dead end whenever the agreement named nothing: an empty table,
                  no quantity to type into, and nothing saying why. */}
              {newItems.length > 0 && (
                <select onChange={(e) => {
                  const i = newItems.find((x) => x.id === e.target.value);
                  if (i) addNewItem(i);
                  e.target.value = "";
                }} defaultValue="">
                  <option value="" disabled>+ Something new from this consignor…</option>
                  {newItems.map((i) => (
                    <option key={i.id} value={i.id}>{i.code} · {i.name}</option>
                  ))}
                </select>
              )}
            </div>
          </>
        )}

        <div className="erp-fields" style={{ marginTop: "0.5rem" }}>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={{ display: "block", fontSize: "var(--erp-text-sm)", color: "var(--erp-fg-muted)" }}>
              Reference (delivery note, etc.)
            </label>
            <input name="reference" type="text" style={{ width: "100%" }} />
          </div>
        </div>

        <div className="erp-foot" style={{ justifyContent: "flex-end" }}>
          {state && "error" in state && <span style={{ color: "var(--bad)", marginRight: "auto" }}>{state.error}</span>}
          <button type="submit" className="erp-btn erp-btn-primary" disabled={pending || lines.every((l) => !Number(l.qty))}>
            {pending ? "Posting…" : "Receive Consignment"}
          </button>
        </div>
      </div>
    </form>
  );
}
