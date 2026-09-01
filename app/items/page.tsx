import Link from "next/link";
import { sql } from "@/lib/db";
import { getCompany, getItems, getBrands } from "@/lib/queries";
import { updateItem, deactivateItem, activateItem, deleteItem } from "@/lib/actions";
import { ItemRow } from "@/components/item-row";
import { DataTable, type DataRow } from "@/components/data-table";

type Row = {
  id: string; code: string; name: string; name_my: string | null;
  item_group_id: string; brand_id: string | null; base_uom_id: string;
  group_name: string; parent_group_name: string | null;
  brand_name: string | null; is_stocked: boolean; is_active: boolean;
  uom_code: string; sale_price: string | null;
};

export default async function Items() {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const [items, brands, uoms] = await Promise.all([
    getItems(company.id) as unknown as Promise<Row[]>,
    getBrands(company.id) as unknown as Promise<{ id: string; code: string; name: string }[]>,
    sql`select id, code, name from uom where company_id = ${company.id} order by code` as unknown as Promise<
      { id: string; code: string; name: string }[]
    >,
  ]);

  const rows: DataRow[] = items.map((i) => ({
    key: i.id,
    searchText: [i.code, i.name, i.name_my, i.group_name, i.parent_group_name, i.brand_name, i.uom_code]
      .filter(Boolean).join(" "),
    sort: {
      code: i.code,
      name: i.name,
      category: i.parent_group_name ?? i.group_name,
      subcategory: i.parent_group_name ? i.group_name : "",
      brand_name: i.brand_name ?? "",
      uom_code: i.uom_code,
      sale_price: Number(i.sale_price ?? 0),
      is_active: i.is_active ? 1 : 0,
    },
    node: (
      <ItemRow
        item={i}
        brands={brands}
        uoms={uoms}
        updateAction={updateItem}
        deactivateAction={deactivateItem}
        activateAction={activateItem}
        deleteAction={deleteItem}
      />
    ),
  }));

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Master data</span>
        <h1>Items</h1>
        <span className="page-sub">
          Every product and service in the catalogue. Filed under a category
          (and sub category, if it has one), with an optional brand.
        </span>
      </div>

      <div className="actions">
        <Link href="/items/categories" className="btn ghost">Manage categories</Link>
        <Link href="/items/brands" className="btn ghost">Manage brands</Link>
        <Link href="/items/new" className="btn">+ Item</Link>
      </div>

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Catalogue</h2>
            <span className="page-sub">{items.length} items</span>
          </div>

          {items.length === 0 ? (
            <div className="empty">
              Nothing yet. Start with a category, then add products inside it.{" "}
              <Link href="/items/categories" style={{ color: "var(--brand)" }}>Add a category</Link>
            </div>
          ) : (
            <DataTable
              rows={rows}
              emptyLabel="No items"
              searchPlaceholder="Search items…"
              defaultSort={{ key: "code", dir: "asc" }}
              columns={[
                { key: "code", label: "Code", sortable: true },
                { key: "name", label: "Name", sortable: true },
                { key: "category", label: "Category", sortable: true },
                { key: "subcategory", label: "Sub category", sortable: true },
                { key: "brand_name", label: "Brand", sortable: true },
                { key: "uom_code", label: "Unit", sortable: true },
                { key: "sale_price", label: "Sale price", sortable: true, align: "r" },
                { key: "actions", label: "" },
              ]}
            />
          )}
        </div>
      </section>
    </>
  );
}
