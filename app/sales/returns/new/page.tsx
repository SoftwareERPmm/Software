import Link from "next/link";
import { getFormData, createSalesReturn } from "@/lib/actions";
import { getReturnableSales } from "@/lib/queries";
import { allCategories } from "@/lib/tree";
import { sql } from "@/lib/db";
import { ReturnForm } from "@/components/return-form";

export default async function NewSalesReturn() {
  const d = await getFormData();
  const [co] = await sql`select id from company order by created_at limit 1`;
  const categories = await allCategories(co.id);
  const salesDocs = await getReturnableSales(co.id);
  const today = new Date().toISOString().slice(0, 10);

  if (d.customers.length === 0 || categories.length === 0 || d.locations.length === 0) {
    return (
      <>
        <div className="page-head">
          <span className="eyebrow">Sales</span>
          <h1>Customer return</h1>
        </div>
        <div className="alert">
          {d.customers.length === 0 && <div>No customers yet — add one first.</div>}
          {categories.length === 0 && <div>No categories yet — add one first.</div>}
          {d.locations.length === 0 && <div>No stock location is set up.</div>}
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Sales</span>
        <h1>Customer return</h1>
        <span className="page-sub">
          Goods come back and the customer owes less — one document for
          both.{" "}
          <Link href="/documents?type=SALES_RETURN" style={{ color: "var(--brand)" }}>Past returns</Link>
        </span>
      </div>

      <ReturnForm
        kind="sales"
        action={createSalesReturn}
        partners={d.customers as never}
        items={d.items as never}
        locations={d.locations as never}
        categories={categories}
        uoms={d.uoms as never}
        today={today}
        salesDocs={salesDocs as never}
      />
    </>
  );
}
