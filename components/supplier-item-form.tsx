"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import type { ActionResult } from "@/lib/actions";
import { ConfirmDelete } from "./confirm-delete";

type Supplier = { id: string; code: string; name: string; lead_time_days: number | null };
type Item = { id: string; code: string; name: string };

/**
 * Recording that one item does not come at its supplier's usual speed.
 *
 * The supplier's own figure is shown as soon as one is chosen, because the
 * number being typed here only means anything against it: "21" is not a
 * fact on its own, "21 where they usually take 14" is.
 */
export function SupplierItemForm({
  action, suppliers, items, companyDefault,
}: {
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  suppliers: Supplier[];
  items: Item[];
  companyDefault: number;
}) {
  const router = useRouter();
  const [state, formAction, pending] =
    useActionState<ActionResult | null, FormData>(action as never, null);
  const [supplierId, setSupplierId] = useState("");

  useEffect(() => { if (state && "ok" in state) router.refresh(); }, [state, router]);

  const chosen = suppliers.find((s) => s.id === supplierId);
  const usual = chosen?.lead_time_days ?? null;

  return (
    <section className="card">
      <div className="card-head">
        <h2>Record an exception</h2>
        <span className="page-sub">
          only where this item differs from the supplier&rsquo;s usual lead time
        </span>
      </div>
      <div className="card-body">
        {state && "error" in state && <div className="alert">{state.error}</div>}
        <form action={formAction} className="attradd">
          <div className="field">
            <label htmlFor="si_supplier">Supplier</label>
            <select id="si_supplier" name="supplier_id" required
                    value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">Choose…</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>{s.code} · {s.name}</option>
              ))}
            </select>
            <span className="hint">
              {!chosen ? " "
                : usual !== null
                  ? `Usually takes ${usual} day${usual === 1 ? "" : "s"}`
                  : `No usual figure set — falls back to ${companyDefault} days`}
            </span>
          </div>

          <div className="field" style={{ flex: "2 1 16rem" }}>
            <label htmlFor="si_item">Item</label>
            <select id="si_item" name="item_id" required defaultValue="">
              <option value="">Choose…</option>
              {items.map((i) => (
                <option key={i.id} value={i.id}>{i.code} · {i.name}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="si_lead">Lead time (days)</label>
            <input id="si_lead" name="lead_time_days" type="number" min="0" max="365"
                   placeholder={usual !== null ? String(usual) : String(companyDefault)} />
            <span className="hint">Blank means no exception</span>
          </div>

          <div className="field">
            <label htmlFor="si_sku">Their code</label>
            <input id="si_sku" name="supplier_sku" type="text" placeholder="Optional" />
          </div>

          <button type="submit" className="btn" disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </button>
        </form>
      </div>
    </section>
  );
}

/** One recorded exception, with what it is an exception to. */
export function SupplierItemRow({
  row, companyDefault, remove,
}: {
  row: {
    id: string; supplier_code: string; supplier_name: string;
    item_code: string; item_name: string;
    lead_time_days: number | null; supplier_default_days: number | null;
    supplier_sku: string | null; note: string | null;
  };
  companyDefault: number;
  remove: (prev: unknown, fd: FormData) => Promise<ActionResult>;
}) {
  const router = useRouter();
  const [state, formAction, pending] =
    useActionState<ActionResult | null, FormData>(remove as never, null);
  useEffect(() => { if (state && "ok" in state) router.refresh(); }, [state, router]);

  /*
   * Three columns, because the override only means anything against what
   * it overrides. "21 days" alone is a number; "21 where they usually take
   * 14" is a decision somebody can check.
   */
  const usual = row.supplier_default_days ?? companyDefault;
  const usualFrom = row.supplier_default_days !== null ? "supplier" : "company";
  const effective = row.lead_time_days ?? usual;

  return (
    <tr>
      <td className="wrap">
        <span className="m">{row.item_code}</span>
        <div className="subline">{row.item_name}</div>
        <div className="subline">{row.supplier_code} · {row.supplier_name}</div>
      </td>
      <td className="r">
        {usual} d
        {usualFrom === "company" && <div className="subline">company default</div>}
      </td>
      <td className="r">
        {row.lead_time_days === null
          ? <span className="page-sub">—</span>
          : `${row.lead_time_days} d`}
      </td>
      <td className="r"><strong>{effective} d</strong></td>
      <td className="code">{row.supplier_sku ?? "—"}</td>
      <td className="wrap">{row.note ?? "—"}</td>
      <td className="tight">
        <ConfirmDelete
          action={formAction as never}
          pending={pending}
          error={state && "error" in state ? state.error : null}
          title="Remove item override?"
          detail={
            row.lead_time_days === null
              ? `This row has no override to remove — it only records `
                + `${row.supplier_code}'s code or a note for ${row.item_code}.`
              : `Removing the ${row.item_name} override of ${row.lead_time_days} days `
                + `means future replenishment calculations will use `
                + `${row.supplier_code}'s ${usualFrom === "supplier" ? "usual" : "company default"} `
                + `${usual} days. Purchase orders already drafted keep the lead time `
                + `they were drafted with.`
          }
          label=""
          confirmLabel="Remove"
          className="btn ghost tiny"
        >
          <input type="hidden" name="id" value={row.id} />
        </ConfirmDelete>
      </td>
    </tr>
  );
}
