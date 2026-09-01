"use client";

import { useActionState, useState, useTransition } from "react";
import type { ActionResult } from "@/lib/actions";
import { createBrandInline, type PickerBrand } from "@/lib/actions";

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
}: {
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  nodes: Node[];
  uoms: Uom[];
  brands: Brand[];
  returnTo: string;
  presetGroupId?: string;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    action as never,
    null
  );

  const [brandList, setBrandList] = useState<Brand[]>(brands);
  const [brandId, setBrandId] = useState("");
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
              <input id="name" name="name" type="text" required placeholder="Apolo Exercise Book" />
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
              <select id="base_uom_id" name="base_uom_id" required defaultValue={uoms[0]?.id ?? ""}>
                {uoms.map((u) => (
                  <option key={u.id} value={u.id}>{u.code} · {u.name}</option>
                ))}
              </select>
              <span className="hint">Stock is always stored in this unit</span>
            </div>

            <div className="field">
              <label htmlFor="sale_price">Sale price</label>
              <input id="sale_price" name="sale_price" type="number" min="0" step="any" />
              <span className="hint">Optional, in MMK</span>
            </div>
          </div>

          <label className="check" htmlFor="is_stocked" style={{ marginTop: "1rem" }}>
            <input id="is_stocked" name="is_stocked" type="checkbox" defaultChecked />
            Stocked — this item moves through inventory
          </label>
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
