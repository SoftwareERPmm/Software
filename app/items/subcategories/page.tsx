import Link from "next/link";
import { sql } from "@/lib/db";
import { allCategories, subcategories, childrenOf, levelCounts, branchIds } from "@/lib/tree";
import { createCategory, updateCategory, deactivateCategory, activateCategory, deleteCategory } from "@/lib/actions";
import { AddCategoryForm } from "@/components/level-form";
import { CategoryRow } from "@/components/category-row";
import { DataTable, type DataRow } from "@/components/data-table";

export default async function Subcategories() {
  const [co] = await sql`select id from company order by created_at limit 1`;
  if (!co) return <div className="empty">No company found.</div>;

  const nodes = await allCategories(co.id);
  const roots = childrenOf(nodes, null);
  const counts = await levelCounts(co.id);
  const subs = subcategories(nodes).map((s) => ({
    ...s,
    parentName: nodes.find((n) => n.id === s.parent_id)?.name ?? null,
    // Categories two levels deep can't have children of their own, so this
    // is always 0 here — kept only because CategoryRow's shape needs it,
    // never shown (see showInside below).
    inside: 0,
    total: branchIds(nodes, s.id).reduce((sum, id) => sum + counts.itemsIn(id), 0),
  }));

  const rows: DataRow[] = subs.map((s) => ({
    key: s.id,
    searchText: [s.code, s.name, s.name_my, s.parentName].filter(Boolean).join(" "),
    sort: {
      code: s.code, name: s.name, parentName: s.parentName ?? "",
      total: s.total, is_active: s.is_active ? 1 : 0,
    },
    node: (
      <CategoryRow
        category={s}
        parentName={s.parentName}
        showInside={false}
        returnTo="/items/subcategories"
        updateAction={updateCategory}
        deactivateAction={deactivateCategory}
        activateAction={activateCategory}
        deleteAction={deleteCategory}
      />
    ),
  }));

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Master data</span>
        <h1>Sub categories</h1>
        <span className="page-sub">
          Every sub category across the whole catalogue, in one flat list —
          the tree view groups them by category; this jumps straight to any of
          them.
        </span>
      </div>

      <AddCategoryForm
        action={createCategory}
        categories={roots}
        returnTo="/items/subcategories"
        label="Sub category"
        codeHint="01"
        nameHint="Soft Drinks"
      />

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Sub categories</h2>
            <span className="page-sub">{subs.length}</span>
          </div>

          {subs.length === 0 ? (
            <div className="empty">
              None yet. Open a category and add a sub category inside it.{" "}
              <Link href="/items/categories" style={{ color: "var(--brand)" }}>Go to categories</Link>
            </div>
          ) : (
            <DataTable
              rows={rows}
              emptyLabel="No sub categories"
              searchPlaceholder="Search sub categories…"
              defaultSort={{ key: "code", dir: "asc" }}
              columns={[
                { key: "code", label: "Code", sortable: true },
                { key: "name", label: "Name", sortable: true },
                { key: "parentName", label: "Category", sortable: true },
                { key: "total", label: "Items", sortable: true, align: "r" },
                { key: "actions", label: "" },
              ]}
            />
          )}
        </div>
      </section>
    </>
  );
}
