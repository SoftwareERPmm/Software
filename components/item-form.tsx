"use client";

import { VariantPicker, type PickerAttribute } from "./variant-picker";
import { PackSizes } from "./pack-sizes";
import { useActionState, useState, useTransition } from "react";
import type { ActionResult } from "@/lib/actions";
import { createBrandInline, type PickerBrand } from "@/lib/actions";
import { ItemPhotoField } from "./item-photo-field";

type Node = {
  id: string; code: string; segment: string; name: string;
  parent_id: string | null;
};
type Uom = { id: string; code: string; name: string };
type Brand = { id: string; code: string; name: string };

// Category depth is capped at two: Category, then Sub category.
const LEVELS = ["Category", "Sub category"];

/**
 * One dropdown per level of the tree. Choosing a category reveals the next
 * dropdown of its children, and the item code assembles from the chain as you
 * go — 01 + 01 + 01 + 001 becomes 010101001.
 */
export function ItemForm({
  action,
  nodes,
  uoms,
  brands,
  returnTo,
  presetGroupId,
  variantAttributes,
}: {
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  nodes: Node[];
  uoms: Uom[];
  brands: Brand[];
  returnTo: string;
  presetGroupId?: string;
  /** The ways products may vary here. Empty where none are set up, which is
   *  the state every catalogue starts in. */
  variantAttributes?: PickerAttribute[];
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    action as never,
    null
  );

  const [tracksBatch, setTracksBatch] = useState(false);
  const [tracksExpiry, setTracksExpiry] = useState(false);
  const [brandList, setBrandList] = useState<Brand[]>(brands);
  const [brandId, setBrandId] = useState("");
  // Controlled, because the pack sizes below have to exclude whichever
  // unit is currently the base — a box cannot contain boxes.
  const [baseUomId, setBaseUomId] = useState(uoms[0]?.id ?? "");
  const [addingBrand, setAddingBrand] = useState(false);
  const [newBrandName, setNewBrandName] = useState("");
  const [brandError, setBrandError] = useState<string | null>(null);
  const [brandPending, startBrand] = useTransition();

  function addBrand() {
    const name = newBrandName.trim();
    if (!name) return;
    setBrandError(null);
    startBrand(async () => {
      const res = await createBrandInline({ name });
      if (!res.ok) {
        setBrandError(res.error);
        return;
      }
      const created: PickerBrand = res.brand;
      setBrandList((list) => [...list, created].sort((a, b) => a.name.localeCompare(b.name)));
      setBrandId(created.id);
      setAddingBrand(false);
      setNewBrandName("");
    });
  }

  // Ancestry of the preset category, so opening this from inside a category
  // starts with the dropdowns already filled in.
  const initialChain = (): string[] => {
    if (!presetGroupId) return [];
    const out: string[] = [];
    let cur = nodes.find((n) => n.id === presetGroupId);
    while (cur) {
      out.unshift(cur.id);
      const pid: string | null = cur.parent_id;
      cur = pid ? nodes.find((n) => n.id === pid) : undefined;
    }
    return out;
  };

  const [chain, setChain] = useState<string[]>(initialChain);
  const [serial, setSerial] = useState("");
  // Controlled only so the variant preview can name the product it is
  // about to make twelve of.
  const [itemName, setItemName] = useState("");

  const childrenOf = (parentId: string | null) =>
    nodes.filter((n) => n.parent_id === parentId);

  // One select per filled level, plus one more offering the next level down.
  const selects: Array<{ depth: number; options: Node[]; value: string }> = [];
  let parent: string | null = null;
  for (let d = 0; ; d++) {
    const options = childrenOf(parent);
    if (options.length === 0) break;
    const value = chain[d] ?? "";
    selects.push({ depth: d, options, value });
    if (!value) break;
    parent = value;
  }

  const selectedId = chain.length > 0 ? chain[chain.length - 1] : "";
  const selected = nodes.find((n) => n.id === selectedId);
  const groupCode = selected?.code ?? "";
  const preview = groupCode && serial ? `${groupCode}${serial}` : "";

  function pick(depth: number, id: string) {
    // Choosing at one level invalidates everything below it.
    setChain(id ? [...chain.slice(0, depth), id] : chain.slice(0, depth));
  }

  return (
    <form action={formAction} className="form">
      {state && "error" in state && <div className="alert">{state.error}</div>}

      <input type="hidden" name="item_group_id" value={selectedId} />
      <input type="hidden" name="brand_id" value={brandId} />
      <input type="hidden" name="return_to" value={returnTo} />

      <div className="card">
        <div className="card-head">
          <h2>Where it belongs</h2>
          <span className="m" style={{ color: "var(--muted)" }}>
            {groupCode ? `Category code ${groupCode}` : "Choose a category"}
          </span>
        </div>
        <div className="card-body">
          <div className="row">
            {selects.map((s) => (
              <div className="field" key={s.depth}>
                <label htmlFor={`lvl-${s.depth}`}>
                  {LEVELS[s.depth] ?? `Level ${s.depth + 1}`}
                </label>
                <select
                  id={`lvl-${s.depth}`}
                  value={s.value}
                  onChange={(e) => pick(s.depth, e.target.value)}
                >
                  <option value="">
                    {s.depth === 0 ? "Choose…" : "— none, file it here —"}
                  </option>
                  {s.options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.segment} · {o.name}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          {selected && (
            <p className="page-sub" style={{ marginTop: "1rem" }}>
              Filing into{" "}
              <span className="m">
                {chain
                  .map((id) => nodes.find((n) => n.id === id)?.name)
                  .filter(Boolean)
                  .join(" → ")}
              </span>
            </p>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>The product</h2>
          {preview && (
            <span className="m" style={{ color: "var(--brand)" }}>Code will be {preview}</span>
          )}
        </div>
        <div className="card-body">
          <div className="row">
            <div className="field">
              <label htmlFor="serial">Serial</label>
              <input
                id="serial" name="serial" type="text" required
                value={serial}
                onChange={(e) => setSerial(e.target.value)}
                placeholder="001"
              />
              <span className="hint">
                {groupCode
                  ? `Appended to ${groupCode}`
                  : "Its own piece of the code"}
              </span>
            </div>

            <div className="field">
              <label htmlFor="name">Name</label>
              <input id="name" name="name" type="text" required placeholder="Apolo Exercise Book"
                     value={itemName} onChange={(e) => setItemName(e.target.value)} />
            </div>

            <div className="field">
              <label htmlFor="name_my">Name (Burmese)</label>
              <input id="name_my" name="name_my" type="text" />
            </div>

            <div className="field">
              <label htmlFor="brand_select">Brand</label>
              {addingBrand ? (
                <>
                  <input
                    id="brand_select" type="text" autoFocus
                    value={newBrandName}
                    onChange={(e) => setNewBrandName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addBrand(); } }}
                    placeholder="Advics"
                  />
                  <span className="actions" style={{ marginTop: "0.4rem" }}>
                    <button type="button" className="tiny" disabled={brandPending || !newBrandName.trim()} onClick={addBrand}>
                      {brandPending ? "Saving…" : "Add"}
                    </button>
                    <button type="button" className="ghost tiny" onClick={() => { setAddingBrand(false); setBrandError(null); }}>
                      Cancel
                    </button>
                  </span>
                  {brandError && <span className="hint" style={{ color: "var(--bad)" }}>{brandError}</span>}
                </>
              ) : (
                <>
                  <select id="brand_select" value={brandId} onChange={(e) => setBrandId(e.target.value)}>
                    <option value="">— none —</option>
                    {brandList.map((b) => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </select>
                  <span className="hint">
                    Optional. <button type="button" className="ghost tiny" style={{ padding: 0 }} onClick={() => setAddingBrand(true)}>+ New brand</button>
                  </span>
                </>
              )}
            </div>

            <div className="field">
              <label htmlFor="base_uom_id">Base unit</label>
              <select id="base_uom_id" name="base_uom_id" required value={baseUomId}
                      onChange={(e) => setBaseUomId(e.target.value)}>
                {uoms.map((u) => (
                  <option key={u.id} value={u.id}>{u.code} · {u.name}</option>
                ))}
              </select>
              <span className="hint">
                Stock is always stored in this unit, and it cannot be changed later
              </span>
            </div>

            {/* The pack sizes were only on the edit panel, so a new item was
                complete except for the one thing its creator had just been
                told by the supplier — and finding it again meant the list,
                the row menu, and Edit. It belongs where the unit is set. */}
            <PackSizes key={baseUomId} uoms={uoms} baseUomId={baseUomId} initial={[]} />

            <div className="field">
              <label htmlFor="sale_price">Sale price</label>
              <input id="sale_price" name="sale_price" type="number" min="0" step="any" />
              <span className="hint">Optional, in MMK</span>
            </div>

            <ItemPhotoField />
          </div>

          <label className="check" htmlFor="is_stocked" style={{ marginTop: "1rem" }}>
            <input id="is_stocked" name="is_stocked" type="checkbox" defaultChecked />
            Stocked — this item moves through inventory
          </label>

          {/* Its own panel, not two more ticks at the foot of the card.
              Whether an item keeps lots decides what every future receipt of
              it will ask for and whether a recall can name the units — a
              bigger decision than the fields above it, and it was reading as
              the smallest thing on the form. Two switches rather than one: a
              batch is traceability, which plenty of goods need without a
              shelf life, and expiry is the extra perishables need, which has
              to belong to a batch. */}
          <fieldset className="trackbox">
            <legend>Traceability</legend>

            <label className="trackbox-opt" htmlFor="tracks_batch">
              <input
                id="tracks_batch" name="tracks_batch" type="checkbox"
                checked={tracksBatch}
                onChange={(e) => {
                  setTracksBatch(e.target.checked);
                  if (!e.target.checked) setTracksExpiry(false);
                }}
              />
              <span>
                <strong>Track batches</strong>
                <span className="trackbox-note">
                  Every receipt of this item says which lot the goods came from,
                  so a recall can name the units.
                </span>
              </span>
            </label>

            <label className={`trackbox-opt sub${tracksBatch ? "" : " off"}`}
                   htmlFor="tracks_expiry">
              <input
                id="tracks_expiry" name="tracks_expiry" type="checkbox"
                checked={tracksExpiry}
                disabled={!tracksBatch}
                onChange={(e) => setTracksExpiry(e.target.checked)}
              />
              <span>
                <strong>Batches expire</strong>
                <span className="trackbox-note">
                  {tracksBatch
                    ? "The oldest-expiring stock is sold first, ahead of any batch that lasts longer."
                    : "Needs batches on first — an expiry date belongs to a lot, not to the item."}
                </span>
              </span>
            </label>

            {/* Said here because this is where somebody expects to type a
                date and finds only a tick. The date is not the item's: one
                item has many lots, each with its own, so it is asked for per
                batch on the way in — and typed by whoever is holding the
                carton, since nothing derives it. */}
            {tracksBatch && (
              <p className="trackbox-where">
                {tracksExpiry
                  ? "No date here — one item has many batches, each with its own. The batch number and its expiry date are typed on the document that brings the goods in: a goods receipt, a purchase bill that receives, or a stock adjustment that finds stock."
                  : "No number here — the batch is typed on the document that brings the goods in: a goods receipt, a purchase bill that receives, or a stock adjustment that finds stock."}
              </p>
            )}
          </fieldset>

          {/* This form creates; adding variants to a product that already has
              stock and history is a larger question and is not offered here. */}
          <VariantPicker attributes={variantAttributes ?? []} serial={serial} name={itemName} />
        </div>
      </div>

      <div className="actions">
        <button type="submit" disabled={pending || !selectedId || !serial}>
          {pending ? "Saving…" : preview ? `Save ${preview}` : "Save item"}
        </button>
        {!selectedId && <span className="page-sub">Choose a category first</span>}
      </div>
    </form>
  );
}
