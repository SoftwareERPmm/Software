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
type Line = { itemId: string; agreementLineId: string; qty: string };

const basis = (l: AgreementLine) =>
  l.pricingMethod === "PERCENTAGE" ? `${l.pricingValue}% of selling price` : `Fixed ${l.pricingValue}/unit`;

export function ConsignmentReceiveForm({
  agreements, locations, today, action,
}: {
  agreements: Agreement[];
  locations: { id: string; code: string; name: string }[];
  today: string;
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
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
    setLines((ls) => [...ls, { itemId: al.itemId, agreementLineId: al.lineId, qty: "" }]);
  const removeLine = (agreementLineId: string) =>
    setLines((ls) => ls.filter((l) => l.agreementLineId !== agreementLineId));
  const setQty = (agreementLineId: string, qty: string) =>
    setLines((ls) => ls.map((l) => (l.agreementLineId === agreementLineId ? { ...l, qty } : l)));

  const payload = JSON.stringify(
    lines.filter((l) => Number(l.qty) > 0).map((l) => ({
      itemId: l.itemId, agreementLineId: l.agreementLineId, qty: Number(l.qty),
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
                {lines.map((line) => {
                  const al = agreement.lines.find((l) => l.lineId === line.agreementLineId)!;
                  return (
                    <tr key={line.agreementLineId} className="erp-tr">
                      <td className="erp-td"><span className="erp-item-code">{al.itemCode}</span>{al.itemName}</td>
                      <td className="erp-td" style={{ color: "var(--erp-fg-muted)" }}>{basis(al)}</td>
                      <td className="erp-td erp-num">
                        <input type="number" min="0" step="0.01" value={line.qty}
                               onChange={(e) => setQty(line.agreementLineId, e.target.value)}
                               style={{ width: 100, textAlign: "right" }} />
                      </td>
                      <td className="erp-td">
                        <button type="button" className="erp-btn"
                                onClick={() => removeLine(line.agreementLineId)}>Remove</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {available.length > 0 && (
              <div style={{ padding: "0.6rem 0" }}>
                <select onChange={(e) => {
                  const al = available.find((l) => l.lineId === e.target.value);
                  if (al) addLine(al);
                  e.target.value = "";
                }} defaultValue="">
                  <option value="" disabled>+ Add an item from this agreement…</option>
                  {available.map((l) => (
                    <option key={l.lineId} value={l.lineId}>{l.itemCode} · {l.itemName} — {basis(l)}</option>
                  ))}
                </select>
              </div>
            )}
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
