import { getFormData, createGoodsReceipt } from "@/lib/actions";
import {
  getOpenPurchaseInvoices, getOpenPurchaseOrders, getGrirCollisions,
  getBillReceiptContext, getRelatedDocuments,
} from "@/lib/queries";
import { ReceiveAgainstBill } from "@/components/receive-against-bill";
import { RelatedDocumentsPanel } from "@/components/related-documents";
import { allCategories } from "@/lib/tree";
import { sql } from "@/lib/db";
import { ReceiptForm } from "@/components/receipt-form";
import { ErpCrumbs } from "@/components/erp-worklist";
import { HelpHint } from "@/components/help-hint";

export default async function NewGoodsReceipt({
  searchParams,
}: {
  searchParams: Promise<{ match_invoice_id?: string }>;
}) {
  const { match_invoice_id } = await searchParams;
  const d = await getFormData();
  const [co] = await sql`select id from company order by created_at limit 1`;

  /**
   * A bill was chosen before this page opened, so the page is about that
   * bill: what it still awaits, the order behind it, and what receiving a
   * given quantity would do to each. The general form below is for goods
   * that arrived with nothing waiting for them, and asking "which invoice?"
   * as its first question when the answer is already known was the source of
   * most of what made this screen hard to read.
   */
  if (match_invoice_id) {
    const bill = await getBillReceiptContext(co.id, match_invoice_id);
    if (bill) {
      const related = await getRelatedDocuments(bill.id);
      const orderId = bill.lines.find((l) => l.orderId)?.orderId ?? null;
      const now = new Date().toTimeString().slice(0, 5);
      return (
        <ReceiveAgainstBill
          action={createGoodsReceipt}
          bill={bill as never}
          locations={d.locations as never}
          today={new Date().toISOString().slice(0, 10)}
          now={now}
          related={<RelatedDocumentsPanel related={related} />}
          backHref={orderId ? `/documents/${orderId}` : `/documents/${bill.id}`}
          backLabel={orderId ? "Back to order" : "Back to bill"}
        />
      );
    }
  }
  const categories = await allCategories(co.id);
  const purchaseInvoices = await getOpenPurchaseInvoices(co.id);

  // Goods waiting on a bill and a bill waiting on goods for the same items:
  // halves of one purchase that never found each other. Keyed by supplier, so
  // the form can say it the moment one is chosen.
  const collisionRows = await getGrirCollisions(co.id);
  const collisions: Record<string, typeof collisionRows> = {};
  for (const r of collisionRows) (collisions[r.partner_id] ??= []).push(r);

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
        <ErpCrumbs steps={[
          { label: "Goods receipts", href: "/purchases/receive" },
          { label: "Receive goods" },
        ]} />
        <div className="page-head">
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
      <ErpCrumbs steps={[
        { label: "Goods receipts", href: "/purchases/receive" },
        { label: "Receive goods" },
      ]} />
      <div className="page-head">
        <h1>Receive goods</h1>
        <HelpHint>
          For stock that arrived with no purchase order behind it. If there
          is an open order, receive against it instead — it keeps track of
          what&rsquo;s still outstanding.
        </HelpHint>
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
        collisions={collisions}
        initialInvoiceId={match_invoice_id}
      />
    </>
  );
}
