"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import type { ActionResult } from "@/lib/actions";

// lib/db.ts opens a real Postgres connection at import time — never import
// it into a client component. Same formatting as money() there, kept local.
const money = (v: string | number | null | undefined) =>
  Number(v ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 });

type Item = {
  id: string; code: string; name: string; name_my: string | null;
  item_group_id: string; brand_id: string | null; base_uom_id: string;
  group_name: string; parent_group_name: string | null; brand_name: string | null;
  uom_code: string; is_stocked: boolean; is_active: boolean; sale_price: string | null;
};
type Brand = { id: string; code: string; name: string };
type Uom = { id: string; code: string; name: string };

export function ItemRow({
  item,
  brands,
  uoms,
  updateAction,
  deleteAction,
  deactivateAction,
}: {
  item: Item;
  brands: Brand[];
  uoms: Uom[];
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
    if (!confirm(`Delete ${item.name}? This can't be undone.`)) e.preventDefault();
  }

  if (editing) {
    return (
      <tr>
        <td colSpan={8}>
          <form action={formAction} className="form" style={{ padding: "0.5rem 0" }}>
            {state && "error" in state && <div className="alert">{state.error}</div>}
            <input type="hidden" name="id" value={item.id} />
            <span className="page-sub">
              {item.code} — code and category are fixed here; use Manage categories to reclassify.
            </span>
            <div className="row" style={{ marginTop: "0.4rem" }}>
              <div className="field">
                <label>Name</label>
                <input name="name" type="text" defaultValue={item.name} required />
              </div>
              <div className="field">
                <label>Name (Burmese)</label>
                <input name="name_my" type="text" defaultValue={item.name_my ?? ""} />
              </div>
              <div className="field">
                <label>Brand</label>
                <select name="brand_id" defaultValue={item.brand_id ?? ""}>
                  <option value="">— none —</option>
                  {brands.map((b) => (
                    <option key={b.id} value={b.id}>{b.code} · {b.name}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Unit</label>
                <select name="base_uom_id" defaultValue={item.base_uom_id} required>
                  {uoms.map((u) => (
                    <option key={u.id} value={u.id}>{u.code} · {u.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <div style={{ display: "flex", gap: "1rem", marginTop: "0.4rem" }}>
              <label className="check">
                <input name="is_stocked" type="checkbox" defaultChecked={item.is_stocked} />
                Stocked (unchecked = service)
              </label>
              <label className="check">
                <input name="is_active" type="checkbox" defaultChecked={item.is_active} />
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
      <td className="code">
        <Link href={`/items/categories/${item.item_group_id}`} style={{ color: "var(--dr)" }}>
          {item.code}
        </Link>
      </td>
      <td className="wrap">
        {item.name}
        {item.name_my && <div className="subline">{item.name_my}</div>}
        {!item.is_stocked && <> <span className="pill">service</span></>}
        {!item.is_active && <> <span className="pill warn">inactive</span></>}
      </td>
      <td style={{ color: "var(--muted)" }}>
        {item.parent_group_name ?? item.group_name}
      </td>
      <td style={{ color: "var(--muted)" }}>
        {item.parent_group_name ? item.group_name : "—"}
      </td>
      <td style={{ color: "var(--muted)" }}>{item.brand_name ?? "—"}</td>
      <td className="code">{item.uom_code}</td>
      <td className="r">{item.sale_price ? money(item.sale_price) : "—"}</td>
      <td>
        <span className="actions">
          <button type="button" className="ghost tiny" onClick={() => setEditing(true)}>Edit</button>
          {item.is_active && (
            <form action={deactFormAction} style={{ display: "inline" }}>
              <input type="hidden" name="id" value={item.id} />
              <button type="submit" className="warn tiny">Deactivate</button>
            </form>
          )}
          <form action={delFormAction} onSubmit={confirmDelete} style={{ display: "inline" }}>
            <input type="hidden" name="id" value={item.id} />
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
