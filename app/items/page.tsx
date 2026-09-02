import Link from "next/link";
import { sql } from "@/lib/db";
import { getCompany, getItems, getBrands } from "@/lib/queries";
import { updateItem, deactivateItem, activateItem, deleteItem } from "@/lib/actions";
import { ItemRow } from "@/components/item-row";
import { DataTable, type DataRow } from "@/components/data-table";
import { ItemFilters } from "@/components/item-filters";

type Row = {
  id: string; code: string; name: string; name_my: string | null;
  item_group_id: string; brand_id: string | null; base_uom_id: string;
  group_name: string; group_parent_id: string | null;
  parent_group_id: string | null; parent_group_name: string | null;
  brand_name: string | null; is_stocked: boolean; is_active: boolean;
  uom_code: string; sale_price: string | null;
  last_purchase_price: string | null;
  last_purchase_doc_no: string | null;
  last_purchase_date: string | null;
};

export default async function Items({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; sub?: string; brand?: string; status?: string }>;
}) {
  const { category, sub, brand, status } = await searchParams;
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const [all, brands, uoms, groups] = await Promise.all([
    getItems(company.id) as unknown as Promise<Row[]>,
    getBrands(company.id) as unknown as Promise<{ id: string; code: string; name: string }[]>,
    sql`select id, code, name from uom where company_id = ${company.id} and is_active order by code` as unknown as Promise<
      { id: string; code: string; name: string }[]
    >,
    sql`select id, name, parent_id from item_group
         where company_id = ${company.id} order by code` as unknown as Promise<
      { id: string; name: string; parent_id: string | null }[]
    >,
  ]);

  /**
   * An item is filed against one category — the leaf. "Category" is therefore
   * that leaf's root ancestor where it has one, and the leaf itself where it
   * does not, which is the same rule the table columns display by. Filtering
   * on a category has to catch the items filed against its children too, or
   * picking "Beverages" would return nothing for a company that files
   * everything one level down.
   */
  const parentOf = new Map(groups.map((g) => [g.id, g.parent_id]));
  const rootOf = (groupId: string): string => {
    let id = groupId;
    for (let hops = 0; hops < 20; hops++) {
      const p = parentOf.get(id);
      if (!p) return id;
      id = p;
    }
    return id;
  };

  const items = all.filter((i) =>
    (!category || rootOf(i.item_group_id) === category) &&
    (!sub || i.item_group_id === sub) &&
    (!brand || (brand === "none" ? i.brand_id === null : i.brand_id === brand)) &&
    (!status || (status === "active" ? i.is_active : !i.is_active))
  );

  const categoryName = (i: Row) => i.parent_group_name ?? i.group_name;
  const subName = (i: Row) => (i.parent_group_name ? i.group_name : "");

  const rows: DataRow[] = items.map((i) => ({
    key: i.id,
    searchText: [i.code, i.name, i.name_my, i.group_name, i.parent_group_name, i.brand_name, i.uom_code]
      .filter(Boolean).join(" "),
    sort: {
      code: i.code,
      name: i.name,
      category: categoryName(i),
      subcategory: subName(i),
      brand_name: i.brand_name ?? "",
      uom_code: i.uom_code,
      sale_price: Number(i.sale_price ?? 0),
      last_purchase_price: Number(i.last_purchase_price ?? 0),
      is_active: i.is_active ? 1 : 0,
    },
    csv: [
      i.code, i.name, i.name_my ?? "", categoryName(i), subName(i),
      i.brand_name ?? "", i.uom_code,
      i.sale_price ?? "", i.last_purchase_price ?? "",
      i.last_purchase_doc_no ?? "", i.last_purchase_date ?? "",
      i.is_active ? "active" : "inactive",
    ],
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

  const priced = items.filter((i) => i.last_purchase_price !== null).length;

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Master data</span>
        <h1>Items</h1>
        <span className="page-sub">
          Every product and service in the catalogue. Filed under a category
          (and sub category, if it has one), with an optional brand. How many
          there are and what they are worth lives under Inventory &mdash; an
          item is what the thing <em>is</em>, not how much of it is on a shelf.
        </span>
      </div>

      <div className="actions">
        <Link href="/items/categories" className="btn ghost">Manage categories</Link>
        <Link href="/items/brands" className="btn ghost">Manage brands</Link>
        <Link href="/items/units" className="btn ghost">Manage units</Link>
        <Link href="/items/import" className="btn ghost">Import</Link>
        <Link href="/items/new" className="btn">+ Item</Link>
      </div>

      <ItemFilters
        groups={groups}
        brands={brands}
        selected={{ category: category ?? "", sub: sub ?? "", brand: brand ?? "", status: status ?? "" }}
      />

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Catalogue</h2>
            <span className="page-sub">
              {items.length === all.length
                ? `${all.length} items`
                : `${items.length} of ${all.length} items`}
              {" · "}{priced} with a purchase price
            </span>
          </div>

          {all.length === 0 ? (
            <div className="empty">
              Nothing yet. Start with a category, then add products inside it.{" "}
              <Link href="/items/categories" style={{ color: "var(--brand)" }}>Add a category</Link>
            </div>
          ) : items.length === 0 ? (
            <div className="empty">
              No item matches these filters.{" "}
              <Link href="/items" style={{ color: "var(--brand)" }}>Clear them</Link>
            </div>
          ) : (
            <DataTable
              rows={rows}
              emptyLabel="No items"
              searchPlaceholder="Search items…"
              defaultSort={{ key: "code", dir: "asc" }}
              csvFilename="items.csv"
              csvHeader={[
                "Code", "Name", "Name (Burmese)", "Category", "Sub category",
                "Brand", "Unit", "Selling price", "Latest purchase price",
                "From invoice", "Invoice date", "Status",
              ]}
              columns={[
                { key: "code", label: "Code", sortable: true },
                { key: "name", label: "Name", sortable: true },
                { key: "category", label: "Category", sortable: true },
                { key: "subcategory", label: "Sub category", sortable: true },
                { key: "brand_name", label: "Brand", sortable: true },
                { key: "uom_code", label: "Unit", sortable: true },
                { key: "sale_price", label: "Selling price", sortable: true, align: "r" },
                { key: "last_purchase_price", label: "Latest purchase price", sortable: true, align: "r" },
                { key: "actions", label: "" },
              ]}
            />
          )}

          <div className="card-body" style={{ paddingTop: 0 }}>
            <span className="page-sub">
              <strong>Latest purchase price</strong> is read from the most recent
              posted purchase invoice for that item &mdash; what the supplier
              actually charged, not a figure kept on the item. It is blank for
              anything received but not yet invoiced, and it changes on its own
              the next time you are billed at a different price.
            </span>
          </div>
        </div>
      </section>
    </>
  );
}
