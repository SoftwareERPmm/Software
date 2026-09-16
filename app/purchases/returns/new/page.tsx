import Link from "next/link";
import { getFormData, createPurchaseReturn } from "@/lib/actions";
import { allCategories } from "@/lib/tree";
import { sql } from "@/lib/db";
import { getReturnablePurchases } from "@/lib/queries";
import { ReturnForm } from "@/components/return-form";
import { ErpCrumbs } from "@/components/erp-worklist";

export default async function NewPurchaseReturn({
  searchParams,
}: {
  searchParams: Promise<{ source?: string }>;
}) {
  const { source } = await searchParams;
  const d = await getFormData();
  const [co] = await sql`select id from company order by created_at limit 1`;
  const categories = await allCategories(co.id);
  const today = new Date().toISOString().slice(0, 10);
  const returnable = await getReturnablePurchases(co.id);

  /**
   * Opened from a goods receipt that is being cancelled because the goods went
   * back. The supplier, the warehouse and the lines are all on that receipt,
   * so asking for them again is asking a question whose answer is already
   * known — and the whole point of coming here from there is not having to go
   * and find it.
   */
  const prefill = source
    ? await (async () => {
        // Either kind of source: a receipt still sitting in the clearing
        // account, or the bill that has since asked for money. Which one is
        // correct is decided by the page sending us here, because that is
        // where it is known — and the engine refuses the wrong one anyway.
        const [doc] = await sql`
          select id, partner_id, location_id, doc_no
            from document
           where id = ${source} and company_id = ${co.id}
             and doc_type in ('GOODS_RECEIPT', 'PURCHASE_INVOICE')
             and status = 'POSTED'`;
        if (!doc) return null;
        const lines = await sql`
          select item_id, base_qty, net_amount
            from document_line where document_id = ${doc.id} order by line_no`;
        return {
          sourceDocumentId: String(doc.id),
          docNo: String(doc.doc_no),
          partnerId: String(doc.partner_id),
          locationId: doc.location_id ? String(doc.location_id) : "",
          lines: (lines as Record<string, unknown>[]).map((l) => ({
            itemId: String(l.item_id),
            qty: String(Number(l.base_qty)),
            // The receipt's own rate, which is the accrual a return has to
            // clear — the form derives the same figure, and starting from it
            // means the two never differ on screen.
            unitPrice: Number(l.base_qty) > 0
              ? String(Number(l.net_amount) / Number(l.base_qty)) : "",
          })),
        };
      })()
    : null;

  if (d.suppliers.length === 0 || categories.length === 0 || d.locations.length === 0) {
    return (
      <>
        <ErpCrumbs steps={[
          { label: "Supplier returns", href: "/purchases/returns" },
          { label: "Supplier return" },
        ]} />
        <div className="page-head">
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
      <ErpCrumbs steps={[
        { label: "Supplier returns", href: "/purchases/returns" },
        ...(prefill ? [{ label: prefill.docNo, href: `/documents/${prefill.sourceDocumentId}` }] : []),
        { label: "Supplier return" },
      ]} />
      <div className="page-head">
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
        salesDocs={returnable as never}
        prefill={prefill as never}
      />
    </>
  );
}
