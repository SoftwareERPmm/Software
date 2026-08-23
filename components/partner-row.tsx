"use client";

import { useActionState, useState } from "react";
import type { ActionResult } from "@/lib/actions";

// lib/db.ts opens a real Postgres connection at import time — never import
// it into a client component. Same formatting as money() there, kept local.
const money = (v: string | number | null | undefined) =>
  Number(v ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 });

type Partner = {
  id: string; code: string; name: string; name_my: string | null; company_name: string | null;
  is_customer: boolean; is_supplier: boolean; is_active: boolean;
  township: string | null; address: string | null; phone: string | null;
  payment_terms_days: number; credit_limit: string | null; outstanding: string;
};

export function PartnerRow({
  partner,
  updateAction,
  deleteAction,
  deactivateAction,
}: {
  partner: Partner;
  updateAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  deleteAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  deactivateAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
}) {
  const [editing, setEditing] = useState(false);
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    updateAction as never,
    null
  );
  const [, deactFormAction] = useActionState<ActionResult | null, FormData>(
    deactivateAction as never,
    null
  );
  const [delState, delFormAction, delPending] = useActionState<ActionResult | null, FormData>(
    deleteAction as never,
    null
  );

  function confirmDelete(e: React.FormEvent<HTMLFormElement>) {
    if (!confirm(`Delete ${partner.name}? This can't be undone.`)) e.preventDefault();
  }

  if (editing) {
    return (
      <tr>
        <td colSpan={7}>
          <form action={formAction} className="form" style={{ padding: "0.5rem 0" }}>
            {state && "error" in state && <div className="alert">{state.error}</div>}
            <input type="hidden" name="id" value={partner.id} />
            <div className="row">
              <div className="field">
                <label>Code</label>
                <input name="code" type="text" defaultValue={partner.code} required />
              </div>
              <div className="field">
                <label>Name</label>
                <input name="name" type="text" defaultValue={partner.name} required />
              </div>
              <div className="field">
                <label>Name (Burmese)</label>
                <input name="name_my" type="text" defaultValue={partner.name_my ?? ""} />
              </div>
              <div className="field">
                <label>Company name</label>
                <input name="company_name" type="text" defaultValue={partner.company_name ?? ""} />
              </div>
              <div className="field">
                <label>Township</label>
                <input name="township" type="text" defaultValue={partner.township ?? ""} />
              </div>
              <div className="field">
                <label>Address</label>
                <input name="address" type="text" defaultValue={partner.address ?? ""} />
              </div>
              <div className="field">
                <label>Phone</label>
                <input name="phone" type="text" defaultValue={partner.phone ?? ""} />
              </div>
              <div className="field">
                <label>Payment terms (days)</label>
                <input name="payment_terms_days" type="number" min="0" defaultValue={partner.payment_terms_days} />
              </div>
              <div className="field">
                <label>Credit limit</label>
                <input name="credit_limit" type="number" min="0" defaultValue={partner.credit_limit ?? ""} />
              </div>
            </div>
            <div style={{ display: "flex", gap: "1rem", marginTop: "0.4rem" }}>
              <label className="check">
                <input name="is_customer" type="checkbox" defaultChecked={partner.is_customer} />
                Customer
              </label>
              <label className="check">
                <input name="is_supplier" type="checkbox" defaultChecked={partner.is_supplier} />
                Supplier
              </label>
              <label className="check">
                <input name="is_active" type="checkbox" defaultChecked={partner.is_active} />
                Active
              </label>
            </div>
            <div className="actions" style={{ marginTop: "0.5rem" }}>
              <button type="submit" disabled={pending}>{pending ? "Saving…" : "Save"}</button>
              <button type="button" className="ghost tiny" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </form>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td className="code">{partner.code}</td>
      <td className="wrap">
        {partner.name}
        {partner.name_my && <div className="subline">{partner.name_my}</div>}
      </td>
      <td>
        {partner.is_customer && <span className="pill ok">Customer</span>}
        {partner.is_customer && partner.is_supplier && " "}
        {partner.is_supplier && <span className="pill warn">Supplier</span>}
      </td>
      <td>{partner.township ?? "—"}</td>
      <td className="r">{partner.payment_terms_days}d</td>
      <td className="r">{Number(partner.outstanding) ? money(partner.outstanding) : "—"}</td>
      <td>{partner.is_active ? <span className="pill ok">active</span> : <span className="pill warn">inactive</span>}</td>
      <td>
        <span className="actions">
          <button type="button" className="ghost tiny" onClick={() => setEditing(true)}>Edit</button>
          {partner.is_active && (
            <form action={deactFormAction} style={{ display: "inline" }}>
              <input type="hidden" name="id" value={partner.id} />
              <button type="submit" className="warn tiny">Deactivate</button>
            </form>
          )}
          <form action={delFormAction} onSubmit={confirmDelete} style={{ display: "inline" }}>
            <input type="hidden" name="id" value={partner.id} />
            <button type="submit" className="danger tiny" disabled={delPending}>
              {delPending ? "Deleting…" : "Delete"}
            </button>
          </form>
        </span>
        {delState && "error" in delState && (
          <div className="hint" style={{ color: "var(--bad)" }}>{delState.error}</div>
        )}
      </td>
    </tr>
  );
}
