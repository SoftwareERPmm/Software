"use client";

import { useActionState, useState } from "react";
import type { ActionResult } from "@/lib/actions";
import { ConfirmDelete } from "./confirm-delete";
import { RowMenu } from "./row-menu";
import { REGION_GROUPS } from "@/lib/regions";

// lib/db.ts opens a real Postgres connection at import time — never import
// it into a client component. Same formatting as money() there, kept local.
const money = (v: string | number | null | undefined) =>
  Number(v ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 });

type Partner = {
  id: string; code: string; name: string; name_my: string | null; company_name: string | null;
  is_customer: boolean; is_supplier: boolean; is_active: boolean;
  region: string | null;
  /** Which column of the price list this customer buys from. */
  price_level_id: string | null; price_level_name: string | null;
  category_id: string | null; category_name: string | null;
  township: string | null; address: string | null; phone: string | null;
  payment_terms_days: number; credit_limit: string | null; outstanding: string;
  /** From v_customer_credit — what the limit is being used for, and what is
   *  left of it. Null for a partner who is not a customer. */
  exposure: string | null; available: string | null;
};

export function PartnerRow({
  partner,
  priceLevels = [],
  categories = [],
  updateAction,
  deleteAction,
  deactivateAction,
  activateAction,
}: {
  partner: Partner;
  /** The company's price columns, so a customer can be put on one. */
  priceLevels?: { id: string; name: string }[];
  categories?: { id: string; name: string }[];
  updateAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  deleteAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  deactivateAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  activateAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
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
  const [, actFormAction] = useActionState<ActionResult | null, FormData>(
    activateAction as never,
    null
  );
  const [delState, delFormAction, delPending] = useActionState<ActionResult | null, FormData>(
    deleteAction as never,
    null
  );


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
                <label>Region / State</label>
                <select name="region" defaultValue={partner.region ?? ""}>
                  <option value="">Not set</option>
                  {REGION_GROUPS.map((g) => (
                    <optgroup key={g.label} label={g.label}>
                      {g.options.map((r) => <option key={r} value={r}>{r}</option>)}
                    </optgroup>
                  ))}
                </select>
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
              {/* Which column of the price list this customer buys from.
                  Only meaningful for a customer, and only worth asking when
                  the company keeps more than one column. */}
              {partner.is_customer && priceLevels.length > 1 && (
                <div className="field">
                  <label>Price level</label>
                  <select name="price_level_id" defaultValue={partner.price_level_id ?? ""}>
                    <option value="">{priceLevels[0]?.name} (default)</option>
                    {priceLevels.map((l) => (
                      <option key={l.id} value={l.id}>{l.name}</option>
                    ))}
                  </select>
                  <span className="hint">Fills the price on a sales line</span>
                </div>
              )}
              {/* Says what the shop is, not what it gets. Kept apart from
                  the price level on purpose: one is a classification, the
                  other is a price. */}
              {categories.length > 0 && (
                <div className="field">
                  <label>Category</label>
                  <select name="category_id" defaultValue={partner.category_id ?? ""}>
                    <option value="">Not categorised</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                  <span className="hint">Groups them on reports only</span>
                </div>
              )}
              <div className="field">
                <label>Credit limit</label>
                <input name="credit_limit" type="number" min="0" defaultValue={partner.credit_limit ?? ""} />
                <span className="hint">
                  As a customer: blank means no limit, 0 means cash only.
                  Checked on every credit sale. Nothing to do with buying
                  from them.
                </span>
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
      <td>
        {partner.region ?? <span style={{ color: "var(--muted)" }}>—</span>}
      </td>
      <td className="wrap">
        {partner.township ?? <span style={{ color: "var(--muted)" }}>—</span>}
      </td>
      <td>
        {partner.is_customer
          ? (partner.price_level_name
              ?? <span style={{ color: "var(--muted)" }}>Default</span>)
          : <span style={{ color: "var(--muted)" }}>—</span>}
      </td>
      <td className="wrap">
        {partner.category_name
          ?? <span style={{ color: "var(--muted)" }}>—</span>}
      </td>
      <td className="r">{partner.payment_terms_days}d</td>
      <td className="r">{Number(partner.outstanding) ? money(partner.outstanding) : "—"}</td>
      {/* What they may owe at once. Blank means nobody has set one; 0 is a
          real answer and means cash only.

          A supplier has neither: a credit limit is what we allow a customer
          to owe us, and printing "No limit" against a supplier would imply
          somebody had considered the question. */}
      <td className="r">
        {!partner.is_customer
          ? <span style={{ color: "var(--muted)" }}>—</span>
          : partner.credit_limit === null
            ? <span style={{ color: "var(--muted)" }}>No limit</span>
            : Number(partner.credit_limit) === 0
              ? <span className="pill warn">Cash only</span>
              : money(partner.credit_limit)}
      </td>
      <td className="r">
        {partner.credit_limit === null || !partner.is_customer ? (
          <span style={{ color: "var(--muted)" }}>—</span>
        ) : Number(partner.available ?? 0) < 0 ? (
          <span className="pill overdue">{money(Math.abs(Number(partner.available)))} over</span>
        ) : (
          money(Number(partner.available ?? partner.credit_limit))
        )}
      </td>
      <td>{partner.is_active ? <span className="pill ok">active</span> : <span className="pill warn">inactive</span>}</td>
      {/* Behind a dot menu, as on the item list. Three buttons on every row
          made the actions column wider than the names, and this table now
          carries money that needs the width more — an amount that wraps is a
          figure somebody misreads. */}
      <td className="r">
        <RowMenu label={`Actions for ${partner.name}`}>
          <button type="button" onClick={() => setEditing(true)}>Edit</button>
          {partner.is_active ? (
            <form action={deactFormAction}>
              <input type="hidden" name="id" value={partner.id} />
              <button type="submit" className="warn">Deactivate</button>
            </form>
          ) : (
            <form action={actFormAction}>
              <input type="hidden" name="id" value={partner.id} />
              <button type="submit">Reactivate</button>
            </form>
          )}
          <div className="rowmenu-sep" />
          <ConfirmDelete
            action={delFormAction}
            pending={delPending}
            error={delState && "error" in delState ? delState.error : null}
            title={`Delete ${partner.name}?`}
            detail="This cannot be undone."
            className="danger"
          >
            <input type="hidden" name="id" value={partner.id} />
          </ConfirmDelete>
        </RowMenu>
        {delState && "error" in delState && (
          <div className="hint" style={{ color: "var(--bad)" }}>{delState.error}</div>
        )}
      </td>
    </tr>
  );
}
