import Link from "next/link";
import { getFormData, createPurchaseReturn } from "@/lib/actions";
import { allCategories } from "@/lib/tree";
import { sql } from "@/lib/db";
import { ReturnForm } from "@/components/return-form";

export default async function NewPurchaseReturn() {
  const d = await getFormData();
  const [co] = await sql`select id from company order by created_at limit 1`;
  const categories = await allCategories(co.id);
  const today = new Date().toISOString().slice(0, 10);

  if (d.suppliers.length === 0 || categories.length === 0 || d.locations.length === 0) {
    return (
      <>
        <div className="page-head">
          <span className="eyebrow">Purchases</span>
          <h1>Supplier return</h1>
        </div>
        <div className="alert">
          {d.suppliers.length === 0 && <div>No suppliers yet — add one first.</div>}
          {categories.length === 0 && <div>No categories yet — add one first.</div>}
          {d.locations.length === 0 && <div>No stock location is set up.</div>}
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Purchases</span>
        <h1>Supplier return</h1>
        <span className="page-sub">
          Goods go back and what&rsquo;s owed drops — one document for both.{" "}
          <Link href="/documents?type=PURCHASE_RETURN" style={{ color: "var(--brand)" }}>Past returns</Link>
        </span>
      </div>

      <ReturnForm
        kind="purchase"
        action={createPurchaseReturn}
        partners={d.suppliers as never}
        items={d.items as never}
        locations={d.locations as never}
        categories={categories}
        uoms={d.uoms as never}
        today={today}
      />
    </>
  );
}
