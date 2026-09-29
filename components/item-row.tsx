"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { ActionResult } from "@/lib/actions";
import { ConfirmDelete } from "./confirm-delete";
import { PackSizes } from "./pack-sizes";
import { RowMenu } from "./row-menu";
import { ItemPhotoField } from "./item-photo-field";
import { ItemThumb } from "./item-thumb";

// lib/db.ts opens a real Postgres connection at import time — never import
// it into a client component. Same formatting as money() there, kept local.
const money = (v: string | number | null | undefined) =>
  Number(v ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 });

type Item = {
  id: string; code: string; name: string; name_my: string | null;
  item_group_id: string; brand_id: string | null; base_uom_id: string;
  group_name: string; parent_group_name: string | null; brand_name: string | null;
  uom_code: string; is_stocked: boolean; is_active: boolean; sale_price: string | null;
  photo_version?: string | null;
  /** The packs this item is bought and sold in, each holding so many base
   *  units. Empty for an item handled only in its own unit. */
  packs?: { uomId: string; factor: number }[];
  last_purchase_price?: string | null;
  last_purchase_doc_no?: string | null;
  last_purchase_date?: string | null;
};
type Brand = { id: string; code: string; name: string };
type Uom = { id: string; code: string; name: string };

export type RowVariant = {
  id: string; code: string; name: string;
  barcode: string | null; qty_on_hand: number; is_active: boolean;
};

export function ItemRow({
  item,
  brands,
  uoms,
  updateAction,
  deleteAction,
  deactivateAction,
  activateAction,
  variants = [],
}: {
  item: Item;
  /** The things on the shelf, where this row is a product that varies.
   *  Empty for an ordinary item, which is nearly every row. */
  variants?: RowVariant[];
  brands: Brand[];
  uoms: Uom[];
  updateAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  deleteAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  deactivateAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  activateAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
}) {
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
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
        <td colSpan={10}>
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
                <span className="hint">What stock is counted in</span>
              </div>
            </div>

            <PackSizes
              uoms={uoms}
              baseUomId={item.base_uom_id}
              initial={item.packs ?? []}
            />
            <div className="row" style={{ marginTop: "0.4rem" }}>
              <ItemPhotoField
                currentSrc={
                  item.photo_version
                    ? `/items/${item.id}/photo?v=${item.photo_version}`
                    : null
                }
              />
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
    <>
    <tr>
      <td className="thumbcell">
        <ItemThumb
          src={item.photo_version ? `/items/${item.id}/photo?v=${item.photo_version}` : null}
          name={item.name}
        />
      </td>
      <td className="code">
        {/* A product that varies opens to show what it varies into. The
            twelve rows are still twelve items; this is only whether the
            catalogue lists them all at once. */}
        {variants.length > 0 && (
          <button type="button" className="stmt-toggle" onClick={() => setOpen(!open)}
                  aria-expanded={open} aria-label={`${variants.length} variants of ${item.code}`}>
            <ChevronRight size={13} aria-hidden="true"
                          style={{ transform: open ? "rotate(90deg)" : "none" }} />
          </button>
        )}
        <Link href={`/items/categories/${item.item_group_id}`} style={{ color: "var(--brand)" }}>
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
      {/* Derived, never stored: the price on the newest posted purchase
          invoice. The document it came from is shown underneath, because a
          figure with no provenance invites being read as "the" cost. */}
      <td className="r">
        {item.last_purchase_price ? money(item.last_purchase_price) : "—"}
        {item.last_purchase_doc_no && (
          <div className="subline" style={{ color: "var(--muted)" }}>
            {item.last_purchase_doc_no}
            {item.last_purchase_date ? ` · ${item.last_purchase_date}` : ""}
          </div>
        )}
      </td>
      <td className="r">
        <RowMenu label={`Actions for ${item.name}`}>
          <button type="button" onClick={() => setEditing(true)}>Edit</button>
          {item.is_active ? (
            <form action={deactFormAction}>
              <input type="hidden" name="id" value={item.id} />
              <button type="submit" className="warn">Deactivate</button>
            </form>
          ) : (
            <form action={actFormAction}>
              <input type="hidden" name="id" value={item.id} />
              <button type="submit">Reactivate</button>
            </form>
          )}
          <div className="rowmenu-sep" />
          <ConfirmDelete
            action={delFormAction}
            pending={delPending}
            error={delState && "error" in delState ? delState.error : null}
            title={`Delete ${item.name}?`}
            detail="This cannot be undone."
            className="danger"
          >
            <input type="hidden" name="id" value={item.id} />
          </ConfirmDelete>
        </RowMenu>
        {delState && "error" in delState && (
          <div className="hint" style={{ color: "var(--bad)" }}>{delState.error}</div>
        )}
      </td>
    </tr>

    {open && variants.map((v) => (
      <tr key={v.id} className="variantrow">
        <td />
        <td className="code">{v.code}</td>
        <td className="wrap">
          {v.name}
          {!v.is_active && <span className="pill" style={{ marginLeft: "0.4rem" }}>Off</span>}
          <div className="subline">
            {v.barcode ? <span className="m">{v.barcode}</span> : "no barcode"}
            {" · "}{v.qty_on_hand} on hand
          </div>
        </td>
        {/* Category, brand and unit are the product's, not the variant's,
            and repeating them down twelve rows says nothing twelve times.
            The table has no barcode or quantity column, so those ride under
            the name rather than being put in somebody else's. */}
        <td colSpan={7} />
      </tr>
    ))}
    </>
  );
}
