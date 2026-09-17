import { getFormData, createSalesOrder } from "@/lib/actions";
import { allCategories } from "@/lib/tree";
import { sql } from "@/lib/db";
import { getUntouchedOpenOrders } from "@/lib/queries";
import { OrderForm } from "@/components/order-form";
import { ErpCrumbs } from "@/components/erp-worklist";
import { HelpHint } from "@/components/help-hint";

export default async function NewSalesOrder() {
  const d = await getFormData();
  const [co] = await sql`select id from company order by created_at limit 1`;
  const categories = await allCategories(co.id);
  const awaiting = await getUntouchedOpenOrders(co.id, "SALES_ORDER");
  const today = new Date().toISOString().slice(0, 10);

  if (d.customers.length === 0 || categories.length === 0 || d.locations.length === 0) {
    return (
      <>
        <ErpCrumbs steps={[
          { label: "Sales orders", href: "/sales/orders" },
          { label: "New sales order" },
        ]} />
        <div className="page-head">
          <h1>New sales order</h1>
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
      <ErpCrumbs steps={[
        { label: "Sales orders", href: "/sales/orders" },
        { label: "New sales order" },
      ]} />
      <div className="page-head">
        <h1>New sales order</h1>
        <HelpHint>
          A commitment from the customer. Deliver against it later — stock
          leaves and cost posts only on delivery, never here.
        </HelpHint>
      </div>

      <OrderForm
        kind="sales"
        action={createSalesOrder}
        partners={d.customers as never}
        items={d.items as never}
        locations={d.locations as never}
        categories={categories}
        uoms={d.uoms as never}
        today={today}
        awaiting={awaiting}
      />
    </>
  );
}
