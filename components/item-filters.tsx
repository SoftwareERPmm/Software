"use client";

import { useRouter, useSearchParams } from "next/navigation";

type Group = { id: string; name: string; parent_id: string | null };
type Brand = { id: string; code: string; name: string };

/**
 * The filter bar over the catalogue.
 *
 * Filters live in the URL rather than in component state, so a filtered list
 * is a link: it survives a reload, it can be bookmarked, and it can be sent
 * to someone who then sees the same rows. That matters more here than on a
 * form, because this is the screen people will be asked to "send me the list
 * of X" from.
 *
 * Sub category is deliberately dependent on Category — offering every sub
 * category at once, from parents you have not chosen, is a list nobody can
 * read once a real catalogue has a few hundred of them.
 */
export function ItemFilters({
  groups,
  brands,
  selected,
}: {
  groups: Group[];
  brands: Brand[];
  selected: { category: string; sub: string; brand: string; status: string };
}) {
  const router = useRouter();
  const params = useSearchParams();

  const roots = groups.filter((g) => !g.parent_id);
  const subs = groups.filter((g) =>
    g.parent_id && (!selected.category || g.parent_id === selected.category)
  );

  function set(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    // Changing the category invalidates a sub category chosen under the old
    // one, which would otherwise silently return nothing.
    if (key === "category") next.delete("sub");
    const qs = next.toString();
    router.push(qs ? `/items?${qs}` : "/items");
  }

  const any = selected.category || selected.sub || selected.brand || selected.status;

  return (
    <div className="row" style={{ alignItems: "flex-end", gap: "0.5rem", marginBottom: "0.75rem" }}>
      <div className="field">
        <label htmlFor="f-category">Category</label>
        <select id="f-category" value={selected.category} onChange={(e) => set("category", e.target.value)}>
          <option value="">All categories</option>
          {roots.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </div>

      <div className="field">
        <label htmlFor="f-sub">Sub category</label>
        <select id="f-sub" value={selected.sub} onChange={(e) => set("sub", e.target.value)}>
          <option value="">All sub categories</option>
          {subs.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </div>

      <div className="field">
        <label htmlFor="f-brand">Brand</label>
        <select id="f-brand" value={selected.brand} onChange={(e) => set("brand", e.target.value)}>
          <option value="">All brands</option>
          <option value="none">— no brand —</option>
          {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </div>

      <div className="field">
        <label htmlFor="f-status">Status</label>
        <select id="f-status" value={selected.status} onChange={(e) => set("status", e.target.value)}>
          <option value="">All</option>
          <option value="active">Active</option>
          <option value="inactive">Deactivated</option>
        </select>
      </div>

      {any && (
        <div className="actions">
          <button type="button" className="ghost" onClick={() => router.push("/items")}>
            Clear filters
          </button>
        </div>
      )}
    </div>
  );
}
