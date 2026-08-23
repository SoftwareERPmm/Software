import Link from "next/link";
import { notFound } from "next/navigation";
import { sql } from "@/lib/db";
import { money, qty } from "@/lib/db";
import {
  createCategory, createItem, insertCategoryAbove, moveCategory,
  updateCategory, deactivateCategory, activateCategory, deleteCategory,
} from "@/lib/actions";
import { getBrands } from "@/lib/queries";
import { allCategories, childrenOf, trail, depthOf, levelCounts, branchIds, levelLabel, levelLabelPlural, MAX_CATEGORY_DEPTH } from "@/lib/tree";
import { AddCategoryForm } from "@/components/level-form";
import { ItemForm } from "@/components/item-form";
import { CategoryRow } from "@/components/category-row";
import { Restructure } from "@/components/restructure";

export default async function CategoryLevel({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [co] = await sql`select id from company order by created_at limit 1`;
  if (!co) return <div className="empty">No company found.</div>;

  const nodes = await allCategories(co.id);
  const here = nodes.find((n) => n.id === id);
  if (!here) notFound();

  const counts = await levelCounts(co.id);
  const kids = childrenOf(nodes, id);
  const crumbs = trail(nodes, id);
  const depth = depthOf(nodes, id);

  const [items, uoms, brands] = await Promise.all([
    sql`select i.id, i.code, i.name, i.name_my, i.is_stocked,
               u.code as uom_code,
               coalesce(s.qty, 0) as on_hand,
               coalesce(s.val, 0) as value_on_hand,
               p.price as sale_price
          from item i
          join uom u on u.id = i.base_uom_id
          left join (select item_id, sum(qty_on_hand) as qty, sum(value_on_hand) as val
                       from v_stock_on_hand group by item_id) s on s.item_id = i.id
          left join item_price p on p.item_id = i.id
         where i.company_id = ${co.id} and i.item_group_id = ${id}
         order by i.code`,
    sql`select id, code, name from uom where company_id = ${co.id} order by code`,
    getBrands(co.id),
  ]);

  const path = crumbs.map((c) => c.name).join(" → ");
  const returnTo = `/items/categories/${id}`;
  const childLabel = levelLabel(depth + 1);
  const childLabelPlural = levelLabelPlural(depth + 1);

  const mine = new Set(branchIds(nodes, id));
  const targets = nodes
    .filter((nd) => !mine.has(nd.id))
    .map((nd) => ({ id: nd.id, name: nd.name, code: nd.code, depth: depthOf(nodes, nd.id) }))
    .sort((a, b) => a.code.localeCompare(b.code));

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">
          <Link href="/items/categories" style={{ color: "var(--muted)" }}>Categories</Link>
          {crumbs.slice(0, -1).map((c) => (
            <span key={c.id}>
              {" / "}
              <Link href={`/items/categories/${c.id}`} style={{ color: "var(--muted)" }}>{c.name}</Link>
            </span>
          ))}
        </span>
        <h1>{here.name}</h1>
        <span className="page-sub">
          <span className="m">{here.code}</span>
          {here.name_my ? ` · ${here.name_my}` : ""}
          {" · "}{levelLabel(depth).toLowerCase()}
          {" · "}{kids.length} inside, {items.length} item{items.length === 1 ? "" : "s"} here
        </span>
      </div>

      {depth < MAX_CATEGORY_DEPTH && (
        <div className="actions">
          <AddCategoryForm
            action={createCategory}
            parentId={id}
            parentCode={here.code}
            returnTo={returnTo}
            label={childLabel}
            codeHint="01"
            nameHint="Exercise Book"
          />
        </div>
      )}

      {depth < MAX_CATEGORY_DEPTH && (
      <section>
        <div className="card">
          <div className="card-head">
            <h2>{childLabelPlural} inside {here.name}</h2>
            <span className="page-sub">{kids.length}</span>
          </div>

          {kids.length === 0 ? (
            <div className="empty">
              Nothing inside yet. Add a {childLabel.toLowerCase()}, or put items
              straight into {here.name} using the form below.
            </div>
          ) : (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Code</th><th>Name</th>
                    <th className="r">Items</th><th />
                  </tr>
                </thead>
                <tbody>
                  {kids.map((g) => {
                    const total = branchIds(nodes, g.id)
                      .reduce((s, cid) => s + counts.itemsIn(cid), 0);
                    return (
                      <CategoryRow
                        key={g.id}
                        category={{ ...g, inside: 0, total }}
                        showInside={false}
                        returnTo={returnTo}
                        updateAction={updateCategory}
                        deactivateAction={deactivateCategory}
                        activateAction={activateCategory}
                        deleteAction={deleteCategory}
                      />
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
      )}

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Add an item here</h2>
            <span className="m" style={{ color: "var(--muted)" }}>
              codes continue from {here.code}
            </span>
          </div>
          <div className="card-body">
            <ItemForm
              action={createItem}
              nodes={nodes}
              uoms={uoms as never}
              brands={brands as never}
              returnTo={returnTo}
              presetGroupId={id}
            />
          </div>
        </div>
      </section>

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Items in {here.name}</h2>
            <span className="page-sub">{items.length}</span>
          </div>

          {items.length === 0 ? (
            <div className="empty">No products sit directly in this category.</div>
          ) : (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Code</th><th>Name</th><th>Unit</th>
                    <th className="r">On hand</th><th className="r">Sale price</th>
                    <th className="r">Stock value</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((i: any) => (
                    <tr key={i.id}>
                      <td className="code">{i.code}</td>
                      <td className="wrap">
                        {i.name}
                        {i.name_my && (
                          <div className="subline">{i.name_my}</div>
                        )}
                        {!i.is_stocked && <> <span className="pill">service</span></>}
                      </td>
                      <td className="code">{i.uom_code}</td>
                      <td className="r">{qty(i.on_hand)}</td>
                      <td className="r">{i.sale_price ? money(i.sale_price) : "—"}</td>
                      <td className="r">{money(i.value_on_hand)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <Restructure
        categoryId={id}
        categoryName={here.name}
        aboveAction={insertCategoryAbove}
        moveAction={moveCategory}
        returnTo="/items/categories"
        targets={targets}
      />
    </>
  );
}
