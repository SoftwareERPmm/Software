import { getFormData, createPurchaseInvoice } from "@/lib/actions";
import { getOpenGoodsReceipts, getOpenOrdersAwaitingGoods } from "@/lib/queries";
import { allCategories } from "@/lib/tree";
import { sql } from "@/lib/db";
import { InvoiceForm } from "@/components/invoice-form";
import { ErpCrumbs } from "@/components/erp-worklist";

export default async function NewPurchaseInvoice({
  searchParams,
}: {
  searchParams: Promise<{ goods_receipt_id?: string }>;
}) {
  const { goods_receipt_id } = await searchParams;
  const { suppliers, items, locations, uoms, cashAccounts } = await getFormData();
  const [co] = await sql`select id from company order by created_at limit 1`;
  const categories = await allCategories(co.id);
  const goodsReceipts = await getOpenGoodsReceipts(co.id);
  // Raised from one receipt's own page: the crumb names it, so the way back
  // leads to that document rather than to a list the reader never came from.
  const from = goods_receipt_id
    ? (goodsReceipts as { id: string; doc_no: string }[]).find((g) => g.id === goods_receipt_id)
    : undefined;
  const awaiting = await getOpenOrdersAwaitingGoods(co.id, "PURCHASE_ORDER");
  const today = new Date().toISOString().slice(0, 10);

  // Items are deliberately not required: a product can be created from the
  // voucher itself. A category is, since nothing unclassified may enter stock.
  if (suppliers.length === 0 || categories.length === 0 || locations.length === 0) {
    return (
      <>
        <ErpCrumbs steps={[
          { label: "Purchase invoices", href: "/purchases/invoices" },
          { label: "New purchase invoice" },
        ]} />
        <div className="page-head">
          <h1>New purchase invoice</h1>
        </div>
        <div className="alert">
          {suppliers.length === 0 && <div>No suppliers yet — add one first.</div>}
          {categories.length === 0 && (
            <div>
              No categories yet — add one first, so new items have somewhere to file.
            </div>
          )}
          {locations.length === 0 && <div>No stock location is set up.</div>}
        </div>
      </>
    );
  }

  return (
    <>
      <ErpCrumbs steps={[
        { label: "Purchase invoices", href: "/purchases/invoices" },
        ...(from ? [{ label: from.doc_no, href: `/documents/${from.id}` }] : []),
        { label: "New purchase invoice" },
      ]} />
      <div className="page-head">
        <h1>New purchase invoice</h1>
        <span className="page-sub">
          Stock arrives at the price paid and the supplier balance opens. Each
          receipt becomes its own FIFO cost layer.
        </span>
      </div>

      <InvoiceForm
        kind="purchase"
        action={createPurchaseInvoice}
        partners={suppliers as never}
        items={items as never}
        locations={locations as never}
        categories={categories}
        uoms={uoms as never}
        today={today}
        cashAccounts={cashAccounts as never}
        goodsReceipts={goodsReceipts as never}
        initialGoodsReceiptId={goods_receipt_id}
        awaiting={awaiting}
      />
    </>
  );
}
