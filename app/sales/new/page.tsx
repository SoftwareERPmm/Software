import { getFormData, createSalesInvoice } from "@/lib/actions";
import { getOpenDeliveries } from "@/lib/queries";
import { allCategories } from "@/lib/tree";
import { sql } from "@/lib/db";
import { SalesVoucher } from "@/components/sales-voucher";

export default async function NewSalesInvoice({
  searchParams,
}: {
  searchParams: Promise<{ delivery_id?: string }>;
}) {
  const { delivery_id } = await searchParams;
  const d = await getFormData();
  const [co] = await sql`select id from company order by created_at limit 1`;
  const categories = await allCategories(co.id);
  const deliveries = await getOpenDeliveries(co.id);
  const today = new Date().toISOString().slice(0, 10);

  // Items are deliberately not required: a product can be created from the
  // voucher itself. A category is, since nothing unclassified may enter stock.
  if (d.customers.length === 0 || categories.length === 0 || d.locations.length === 0) {
    return (
      <>
        <div className="page-head">
          <span className="eyebrow">Sales</span>
          <h1>Sales voucher</h1>
        </div>
        <div className="alert">
          {d.customers.length === 0 && <div>No customers yet — add one first.</div>}
          {categories.length === 0 && (
            <div>
              No categories yet — add one first, so new items have somewhere to file.
            </div>
          )}
          {d.locations.length === 0 && <div>No stock location is set up.</div>}
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Sales</span>
        <h1>Sales voucher</h1>
        <span className="page-sub">
          ကုန်ပစ္စည်းများသည် FIFO ကုန်ကျစရိတ်ဖြင့် ထွက်ခွာပြီး၊ ဝင်ငွေကို
          အသိအမှတ်ပြုကာ လက်ကျန်ငွေကို ဤ Invoice တွင် ဖွင့်ပေးပါသည်။
          <div className="subline" style={{ marginTop: "0.15rem" }}>
            Stock leaves at its FIFO cost, revenue is recognised, and the balance opens against this invoice.
          </div>
        </span>
      </div>

      <SalesVoucher
        action={createSalesInvoice}
        customers={d.customers as never}
        items={d.items as never}
        locations={d.locations as never}
        salesmen={d.salesmen as never}
        cashAccounts={d.cashAccounts as never}
        promotions={d.promotions as never}
        focReasons={d.focReasons as never}
        openInvoices={d.openInvoices as never}
        stockByLocation={d.stockByLocation as never}
        itemPrices={d.itemPrices as never}
        priceLevels={d.priceLevels as never}
        categories={categories}
        uoms={d.uoms as never}
        nextInvoiceNo={d.nextInvoiceNo}
        today={today}
        deliveries={deliveries as never}
        initialDeliveryId={delivery_id}
      />
    </>
  );
}
