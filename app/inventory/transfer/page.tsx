import Link from "next/link";
import { getFormData, createStockTransfer } from "@/lib/actions";
import { allCategories } from "@/lib/tree";
import { sql } from "@/lib/db";
import { StockTransferForm } from "@/components/stock-transfer-form";

export default async function NewStockTransfer() {
  const d = await getFormData();
  const [co] = await sql`select id from company order by created_at limit 1`;
  const categories = await allCategories(co.id);
  const today = new Date().toISOString().slice(0, 10);

  if (categories.length === 0 || d.locations.length < 2) {
    return (
      <>
        <div className="page-head">
          <span className="eyebrow">Inventory</span>
          <h1>Stock transfer</h1>
        </div>
        <div className="alert">
          {categories.length === 0 && <div>No categories yet — add one first.</div>}
          {d.locations.length < 2 && <div>Needs at least two stock locations set up.</div>}
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Inventory</span>
        <h1>Stock transfer</h1>
        <span className="page-sub">
          Move stock between two of the company&rsquo;s own warehouses — the
          company-wide total never changes, only which location holds it.{" "}
          <Link href="/documents?type=STOCK_TRANSFER" style={{ color: "var(--brand)" }}>
            Past transfers
          </Link>
        </span>
      </div>

      <StockTransferForm
        action={createStockTransfer}
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
