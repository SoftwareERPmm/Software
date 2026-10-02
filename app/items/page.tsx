import Link from "next/link";
import { sql } from "@/lib/db";
import { getCompany, getItems, getBrands } from "@/lib/queries";
import { updateItem, deactivateItem, activateItem, deleteItem, setVariantPhoto } from "@/lib/actions";
import { ItemRow } from "@/components/item-row";
import { asVariant } from "@/components/variant-tags";
import { DataTable, type DataRow } from "@/components/data-table";
import { ItemFilters } from "@/components/item-filters";
import { HelpHint } from "@/components/help-hint";

type Row = {
  id: string; code: string; name: string; name_my: string | null;
  item_group_id: string; brand_id: string | null; base_uom_id: string;
  group_name: string; group_parent_id: string | null;
  parent_group_id: string | null; parent_group_name: string | null;
  brand_name: string | null; is_stocked: boolean; is_active: boolean;
  uom_code: string; sale_price: string | null;
  photo_version: string | null;
  last_purchase_price: string | null;
  last_purchase_doc_no: string | null;
  last_purchase_date: string | null;
  parent_item_id: string | null;
  variant_count: number;
  variant: unknown;
  barcode: string | null;
  qty_on_hand: string | number | null;
};

export default async function Items({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; sub?: string; brand?: string; status?: string;
                          edit?: string }>;
}) {
  const { category, sub, brand, status, edit } = await searchParams;
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const [all, brands, uoms, groups, packs] = await Promise.all([
    getItems(company.id) as unknown as Promise<Row[]>,
    getBrands(company.id) as unknown as Promise<{ id: string; code: string; name: string }[]>,
    sql`select id, code, name from uom where company_id = ${company.id} and is_active order by code` as unknown as Promise<
      { id: string; code: string; name: string }[]
    >,
    sql`select id, name, parent_id from item_group
         where company_id = ${company.id} order by code` as unknown as Promise<
      { id: string; name: string; parent_id: string | null }[]
    >,
    // Every pack size in one query rather than one per item: the list is
    // short, and a hundred round trips to draw a hundred rows is not.
    sql`select iu.item_id, iu.uom_id, iu.factor, u.code as uom_code
          from item_uom iu
          join item i on i.id = iu.item_id
          join uom u on u.id = iu.uom_id
         where i.company_id = ${company.id}
         order by u.code` as unknown as Promise<
      Array<{ item_id: string; uom_id: string; factor: string; uom_code: string }>>,
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

  /**
   * Variants are folded into the product they belong to.
   *
   * A shirt in four sizes and three colours is twelve item rows, and a
   * catalogue that lists all twelve buries everything else. The parent
   * stands for them here and the row expands to show them; the twelve are
   * still ordinary items everywhere it matters — stock, prices, documents,
   * search by barcode.
   *
   * A variant whose parent is filtered out of this view would vanish
   * entirely, so the fold happens before the filters rather than after.
   */
  const variantsByParent = new Map<string, Row[]>();
  for (const i of all) {
    if (!i.parent_item_id) continue;
    const list = variantsByParent.get(i.parent_item_id) ?? [];
    list.push(i);
    variantsByParent.set(i.parent_item_id, list);
  }
  const catalogue = all.filter((i) => !i.parent_item_id);

  const items = catalogue.filter((i) =>
    (!category || rootOf(i.item_group_id) === category) &&
    (!sub || i.item_group_id === sub) &&
    (!brand || (brand === "none" ? i.brand_id === null : i.brand_id === brand)) &&
    (!status || (status === "active" ? i.is_active : !i.is_active))
  );

  const categoryName = (i: Row) => i.parent_group_name ?? i.group_name;
  const subName = (i: Row) => (i.parent_group_name ? i.group_name : "");

  const rows: DataRow[] = items.map((i) => ({
    key: i.id,
    // The variants' own codes and barcodes belong here too. Folding them
    // under the parent must not make them unfindable: scanning a barcode for
    // "POLO-M-Red" has to land somewhere, and the row it lands on is the one
    // that opens to show it.
    searchText: [i.code, i.name, i.name_my, i.group_name, i.parent_group_name, i.brand_name, i.uom_code,
                 i.barcode,
                 // Searching "CTN" should find what comes by the carton.
                 ...packs.filter((p) => p.item_id === i.id).map((p) => p.uom_code),
                 ...(variantsByParent.get(i.id) ?? []).flatMap((v) => [v.code, v.name, v.barcode])]
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
    // Keyed by column, so hiding a column on screen drops it from the file
    // too. The four keys with no column of their own are export-only, listed
    // in csvExtra below.
    csv: {
      code: i.code,
      name: i.name,
      name_my: i.name_my ?? "",
      category: categoryName(i),
      subcategory: subName(i),
      brand_name: i.brand_name ?? "",
      uom_code: i.uom_code,
      sale_price: i.sale_price ?? "",
      last_purchase_price: i.last_purchase_price ?? "",
      last_purchase_doc_no: i.last_purchase_doc_no ?? "",
      last_purchase_date: i.last_purchase_date ?? "",
      status: i.is_active ? "active" : "inactive",
    },
    node: (
      <ItemRow
        startEditing={edit === i.id}
        item={{
          ...i,
          packs: packs
            .filter((p) => p.item_id === i.id)
            .map((p) => ({ uomId: p.uom_id, code: p.uom_code, factor: Number(p.factor) })),
        }}
        brands={brands}
        uoms={uoms}
        updateAction={updateItem}
        deactivateAction={deactivateItem}
        activateAction={activateItem}
        deleteAction={deleteItem}
        setPhotoAction={setVariantPhoto}
        variants={(variantsByParent.get(i.id) ?? []).map((v) => ({
          id: v.id, code: v.code, name: v.name,
          barcode: v.barcode ?? null,
          qty_on_hand: Number(v.qty_on_hand ?? 0),
          is_active: v.is_active,
          photo_version: v.photo_version ?? null,
          variant_parts: asVariant(v.variant),
        }))}
      />
    ),
  }));

  const priced = items.filter((i) => i.last_purchase_price !== null).length;

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Master data</span>
        <h1>Items</h1>
        <HelpHint>
          Every product and service in the catalogue. Filed under a category
          (and sub category, if it has one), with an optional brand. How many
          there are and what they are worth lives under Inventory &mdash; an
          item is what the thing <em>is</em>, not how much of it is on a shelf.
        </HelpHint>
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
              initialQuery={edit ? (items.find((i: any) => i.id === edit)?.code ?? "") : undefined}
              defaultSort={{ key: "code", dir: "asc" }}
              csvFilename="items.csv"
              storageKey="items"
              // Never on screen, always in the file: a Burmese name and a
              // status are wanted in a spreadsheet and would only widen a
              // table that already has ten columns.
              csvExtra={[
                { key: "name_my", label: "Name (Burmese)" },
                { key: "last_purchase_doc_no", label: "From invoice" },
                { key: "last_purchase_date", label: "Invoice date" },
                { key: "status", label: "Status" },
              ]}
              columns={[
                { key: "photo", label: "" },
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
