import { sql } from "@/lib/db";
import { createCategory, updateCategory, deactivateCategory, activateCategory, deleteCategory } from "@/lib/actions";
import { allCategories, childrenOf, levelCounts, branchIds } from "@/lib/tree";
import { AddCategoryForm } from "@/components/level-form";
import { CategoryRow } from "@/components/category-row";
import { DataTable, type DataRow } from "@/components/data-table";

export default async function CategoriesRoot() {
  const [co] = await sql`select id from company order by created_at limit 1`;
  if (!co) return <div className="empty">No company found.</div>;

  const nodes = await allCategories(co.id);
  const counts = await levelCounts(co.id);
  const roots = childrenOf(nodes, null).map((g) => ({
    ...g,
    inside: counts.childrenOf(g.id),
    total: branchIds(nodes, g.id).reduce((s, id) => s + counts.itemsIn(id), 0),
  }));

  const rows: DataRow[] = roots.map((g) => ({
    key: g.id,
    searchText: [g.code, g.name, g.name_my].filter(Boolean).join(" "),
    sort: { code: g.code, name: g.name, inside: g.inside, total: g.total, is_active: g.is_active ? 1 : 0 },
    node: (
      <CategoryRow
        category={g}
        returnTo="/items/categories"
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
        <h1>Categories</h1>
        <span className="page-sub">
          The top of your product tree. Open one to add categories inside it,
          then keep going until you reach the products themselves.
        </span>
      </div>

      <AddCategoryForm
        action={createCategory}
        parentId={null}
        returnTo="/items/categories"
        label="Category"
        codeHint="01"
        nameHint="Stationary"
      />

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Categories</h2>
            <span className="page-sub">{roots.length}</span>
          </div>

          {roots.length === 0 ? (
            <div className="empty">
              Nothing yet. Add a category &mdash; the broadest grouping you
              use, like Food &amp; Drink or Household.
            </div>
          ) : (
            <DataTable
              rows={rows}
              emptyLabel="No categories"
              searchPlaceholder="Search categories…"
              defaultSort={{ key: "code", dir: "asc" }}
              columns={[
                { key: "code", label: "Code", sortable: true },
                { key: "name", label: "Name", sortable: true },
                { key: "inside", label: "Inside", sortable: true, align: "r" },
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
