import { getFormData, createGoodsReceipt } from "@/lib/actions";
import { getOpenPurchaseInvoices, getOpenPurchaseOrders } from "@/lib/queries";
import { allCategories } from "@/lib/tree";
import { sql } from "@/lib/db";
import { ReceiptForm } from "@/components/receipt-form";

export default async function NewGoodsReceipt({
  searchParams,
}: {
  searchParams: Promise<{ match_invoice_id?: string }>;
}) {
  const { match_invoice_id } = await searchParams;
  const d = await getFormData();
  const [co] = await sql`select id from company order by created_at limit 1`;
  const categories = await allCategories(co.id);
  const purchaseInvoices = await getOpenPurchaseInvoices(co.id);

  // Open order lines, per supplier, so the form can say "these goods look
  // like they answer PO20260902002" before someone records them as arriving
  // from nowhere. A receipt that names no order leaves that order at zero
  // received for good: nothing in the record connects the two, and guessing
  // by item afterwards would close the wrong order as readily as the right
  // one. So it is asked here, while the answer is still known.
  const openOrders = await getOpenPurchaseOrders(co.id) as unknown as Array<{
    order_id: string; order_no: string; partner_id: string;
    item_id: string; item_code: string; remaining_qty: string;
  }>;
  const ordersBySupplier = new Map<string, {
    orderId: string; orderNo: string; lines: { itemId: string; itemCode: string; qty: number }[];
  }[]>();
  for (const r of openOrders) {
    const list = ordersBySupplier.get(r.partner_id) ?? [];
    let order = list.find((o) => o.orderId === r.order_id);
    if (!order) { order = { orderId: r.order_id, orderNo: r.order_no, lines: [] }; list.push(order); }
    order.lines.push({ itemId: r.item_id, itemCode: r.item_code, qty: Number(r.remaining_qty) });
    ordersBySupplier.set(r.partner_id, list);
  }
  const today = new Date().toISOString().slice(0, 10);

  if (d.suppliers.length === 0 || categories.length === 0 || d.locations.length === 0) {
    return (
      <>
        <div className="page-head">
          <span className="eyebrow">Purchases</span>
          <h1>Receive goods</h1>
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
        <h1>Receive goods</h1>
        <span className="page-sub">
          For stock that arrived with no purchase order behind it. If there
          is an open order, receive against it instead — it keeps track of
          what&rsquo;s still outstanding.
        </span>
      </div>

      <ReceiptForm
        action={createGoodsReceipt}
        suppliers={d.suppliers as never}
        items={d.items as never}
        locations={d.locations as never}
        categories={categories}
        uoms={d.uoms as never}
        today={today}
        purchaseInvoices={purchaseInvoices as never}
        openOrders={Object.fromEntries(ordersBySupplier)}
        initialInvoiceId={match_invoice_id}
      />
    </>
  );
}
