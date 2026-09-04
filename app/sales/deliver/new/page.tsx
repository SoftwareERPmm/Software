import Link from "next/link";
import { getFormData, createDelivery } from "@/lib/actions";
import { getOpenSalesOrders, getStockByLocation } from "@/lib/queries";
import { allCategories } from "@/lib/tree";
import { sql } from "@/lib/db";
import { DeliveryForm } from "@/components/delivery-form";

export default async function NewDelivery() {
  const d = await getFormData();
  const [co] = await sql`select id from company order by created_at limit 1`;
  const [categories, openOrders, stockByLocation, focReasons] = await Promise.all([
    allCategories(co.id),
    getOpenSalesOrders(co.id),
    getStockByLocation(co.id),
    sql`select id, code, name from foc_reason where company_id = ${co.id} order by code`,
  ]);
  const today = new Date().toISOString().slice(0, 10);

  if (d.customers.length === 0 || categories.length === 0 || d.locations.length === 0) {
    return (
      <>
        <div className="page-head">
          <span className="eyebrow">Sales</span>
          <h1>Deliver goods</h1>
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
        <h1>Deliver goods</h1>
        <span className="page-sub">
          For stock leaving with nothing raised beforehand &mdash; goods
          dropped at a shop to be billed later, or samples given away with no
          sale at all. An order is optional: if there is one open, delivering
          against it keeps track of what is still owed. Stock leaves at its
          FIFO cost and the cost is recognised; revenue and the receivable
          belong to the invoice, whenever it is raised.
        </span>
        <Link href="/sales/deliver" className="btn ghost">Back to deliveries</Link>
      </div>

      <DeliveryForm
        action={createDelivery}
        customers={d.customers as never}
        items={d.items as never}
        locations={d.locations as never}
        categories={categories}
        uoms={d.uoms as never}
        stockByLocation={stockByLocation as never}
        focReasons={focReasons as never}
        openOrders={openOrders as never}
        today={today}
      />
    </>
  );
}
