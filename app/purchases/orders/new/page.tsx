import { getFormData, createPurchaseOrder } from "@/lib/actions";
import { allCategories } from "@/lib/tree";
import { sql } from "@/lib/db";
import { getUntouchedOpenOrders } from "@/lib/queries";
import { OrderForm } from "@/components/order-form";
import { ErpCrumbs } from "@/components/erp-worklist";
import { HelpHint } from "@/components/help-hint";

export default async function NewPurchaseOrder() {
  const d = await getFormData();
  const [co] = await sql`select id from company order by created_at limit 1`;
  const categories = await allCategories(co.id);
  const awaiting = await getUntouchedOpenOrders(co.id, "PURCHASE_ORDER");
  const today = new Date().toISOString().slice(0, 10);

  if (d.suppliers.length === 0 || categories.length === 0 || d.locations.length === 0) {
    return (
      <>
        <ErpCrumbs steps={[
          { label: "Purchase orders", href: "/purchases/orders" },
          { label: "New purchase order" },
        ]} />
        <div className="page-head">
          <h1>New purchase order</h1>
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
      <ErpCrumbs steps={[
        { label: "Purchase orders", href: "/purchases/orders" },
        { label: "New purchase order" },
      ]} />
      <div className="page-head">
        <h1>New purchase order</h1>
        <HelpHint>
          A commitment to the supplier. Receive against it later — stock
          arrives and cost posts only on goods receipt, never here.
        </HelpHint>
      </div>

      <OrderForm
        kind="purchase"
        action={createPurchaseOrder}
        partners={d.suppliers as never}
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
