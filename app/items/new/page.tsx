import Link from "next/link";
import { sql } from "@/lib/db";
import { createItem } from "@/lib/actions";
import { allCategories } from "@/lib/tree";
import { getBrands } from "@/lib/queries";
import { ItemForm } from "@/components/item-form";

export default async function NewItem() {
  const [co] = await sql`select id from company order by created_at limit 1`;
  if (!co) return <div className="empty">No company found.</div>;

  const [nodes, uoms, brands] = await Promise.all([
    allCategories(co.id),
    sql`select id, code, name from uom where company_id = ${co.id} and is_active order by code`,
    getBrands(co.id),
  ]);

  if (nodes.length === 0) {
    return (
      <>
        <div className="page-head">
          <span className="eyebrow">Master data</span>
          <h1>New item</h1>
        </div>
        <div className="alert">
          No categories exist yet.{" "}
          <Link href="/items/categories" style={{ textDecoration: "underline" }}>
            Add a category first.
          </Link>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Master data</span>
        <h1>New item</h1>
        <span className="page-sub">
          Pick the category at each level. The item&rsquo;s code is built from the
          ones above it, so the code alone tells you where a product sits.
        </span>
      </div>

      <ItemForm
        action={createItem}
        nodes={nodes}
        uoms={uoms as never}
        brands={brands as never}
        returnTo="/items"
      />
    </>
  );
}
