import Link from "next/link";
import { getFormData, createDelivery } from "@/lib/actions";
import {
  getOpenSalesOrders, getStockByLocation, getOwnershipMap,
  getInvoiceDeliveryContext, getRelatedDocuments,
} from "@/lib/queries";
import { DeliverAgainstInvoice } from "@/components/deliver-against-invoice";
import { RelatedDocumentsPanel } from "@/components/related-documents";
import { allCategories } from "@/lib/tree";
import { sql } from "@/lib/db";
import { DeliveryForm } from "@/components/delivery-form";
import { ErpCrumbs } from "@/components/erp-worklist";

export default async function NewDelivery({
  searchParams,
}: {
  searchParams?: Promise<{ match_invoice_id?: string }>;
}) {
  const { match_invoice_id } = (await searchParams) ?? {};
  const d = await getFormData();
  const [co] = await sql`select id from company order by created_at limit 1`;

  /**
   * An invoice was chosen before this page opened, so the page is about that
   * invoice — the mirror of receiving against a bill, and for the same
   * reason: the first question has already been answered and asking it again
   * is what made the screen hard to read.
   */
  if (match_invoice_id) {
    const invoice = await getInvoiceDeliveryContext(co.id, match_invoice_id);
    if (invoice) {
      const related = await getRelatedDocuments(invoice.id);
      const orderId = invoice.lines.find((l) => l.orderId)?.orderId ?? null;
      return (
        <DeliverAgainstInvoice
          action={createDelivery}
          invoice={invoice as never}
          today={new Date().toISOString().slice(0, 10)}
          related={<RelatedDocumentsPanel related={related} />}
          backHref={orderId ? `/documents/${orderId}` : `/documents/${invoice.id}`}
          backLabel={orderId ? "Back to order" : "Back to invoice"}
        />
      );
    }
  }
  const [categories, openOrders, stockByLocation, focReasons, ownership] = await Promise.all([
    allCategories(co.id),
    getOpenSalesOrders(co.id),
    getStockByLocation(co.id),
    sql`select id, code, name from foc_reason where company_id = ${co.id} order by code`,
    // Consigned stock on hand, so the line can offer whose goods it is
    // issuing. Owned and consigned sit in the same warehouse and nothing
    // about the shelf tells them apart.
    getOwnershipMap(co.id),
  ]);
  const today = new Date().toISOString().slice(0, 10);

  if (d.customers.length === 0 || categories.length === 0 || d.locations.length === 0) {
    return (
      <>
        <ErpCrumbs steps={[
          { label: "Deliveries", href: "/sales/deliver" },
          { label: "Deliver goods" },
        ]} />
        <div className="page-head">
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
      <ErpCrumbs steps={[
        { label: "Deliveries", href: "/sales/deliver" },
        { label: "Deliver goods" },
      ]} />
      <div className="page-head">
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
        ownership={ownership.consigned as never}
        today={today}
      />
    </>
  );
}
