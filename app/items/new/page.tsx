import Link from "next/link";
import { sql } from "@/lib/db";
import { createItem } from "@/lib/actions";
import { allCategories } from "@/lib/tree";
import { getBrands, getVariantAttributes} from "@/lib/queries";
import { ItemForm } from "@/components/item-form";
import { HelpHint } from "@/components/help-hint";

export default async function NewItem() {
  const [co] = await sql`select id from company order by created_at limit 1`;
  if (!co) return <div className="empty">No company found.</div>;

  const [nodes, uoms, brands, variantAttributes] = await Promise.all([
    allCategories(co.id),
    sql`select id, code, name from uom where company_id = ${co.id} and is_active order by code`,
    getBrands(co.id),
    getVariantAttributes(co.id),
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
        <HelpHint>
          Pick the category at each level. The item&rsquo;s code is built from the
          ones above it, so the code alone tells you where a product sits.
        </HelpHint>
      </div>

      <ItemForm
        variantAttributes={variantAttributes as never}
        action={createItem}
        nodes={nodes}
        uoms={uoms as never}
        brands={brands as never}
        returnTo="/items"
      />
    </>
  );
}
