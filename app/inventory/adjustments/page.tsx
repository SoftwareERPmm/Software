import Link from "next/link";
import { getFormData, createStockAdjustment } from "@/lib/actions";
import { allCategories } from "@/lib/tree";
import { sql } from "@/lib/db";
import { AdjustmentForm } from "@/components/adjustment-form";

export default async function NewStockAdjustment() {
  const d = await getFormData();
  const [co] = await sql`select id from company order by created_at limit 1`;
  const categories = await allCategories(co.id);
  const today = new Date().toISOString().slice(0, 10);

  if (categories.length === 0 || d.locations.length === 0) {
    return (
      <>
        <div className="page-head">
          <span className="eyebrow">Inventory</span>
          <h1>Stock adjustment</h1>
        </div>
        <div className="alert">
          {categories.length === 0 && <div>No categories yet — add one first.</div>}
          {d.locations.length === 0 && <div>No stock location is set up.</div>}
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Inventory</span>
        <h1>Stock adjustment</h1>
        <span className="page-sub">
          Correct a count — damage, shrinkage, or what the shelf actually
          holds versus what the ledger says.{" "}
          <Link href="/documents?type=STOCK_ADJUSTMENT" style={{ color: "var(--brand)" }}>
            Past adjustments
          </Link>
        </span>
      </div>

      <AdjustmentForm
        action={createStockAdjustment}
        items={d.items as never}
        locations={d.locations as never}
        stockByLocation={d.stockByLocation as never}
        categories={categories}
        uoms={d.uoms as never}
        today={today}
      />
    </>
  );
}
