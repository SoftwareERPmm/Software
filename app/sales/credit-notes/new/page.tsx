import { notFound } from "next/navigation";
import { sql } from "@/lib/db";
import { createCreditNote } from "@/lib/actions";
import { NoteForm } from "@/components/note-form";
import { ErpCrumbs } from "@/components/erp-worklist";
import { HelpHint } from "@/components/help-hint";

export default async function NewCreditNote({
  searchParams,
}: {
  searchParams: Promise<{ invoice?: string }>;
}) {
  const { invoice } = await searchParams;
  const [co] = await sql`select id from company order by created_at limit 1`;
  if (!co) return <div className="empty">No company found.</div>;

  /* A note always names an invoice, so this page is only reachable with one.
     Without it there is nothing to reduce and no balance to check against. */
  const [inv] = invoice
    ? await sql`
        select d.id, d.doc_no, to_char(d.doc_date, 'YYYY-MM-DD') as doc_date,
               d.partner_id, p.name as partner_name, d.gross_total,
               coalesce((select outstanding from v_open_item where document_id = d.id), 0) as outstanding
          from document d
          join business_partner p on p.id = d.partner_id
         where d.id = ${invoice} and d.company_id = ${co.id}
           and d.doc_type = 'SALES_INVOICE' and d.status = 'POSTED'`
    : [];
  if (!inv) notFound();

  const taxCodes = await sql`
    select t.id, t.code, fn_tax_rate_on(t.id, current_date) as rate
      from tax_code t
     where t.company_id = ${co.id} and t.is_active
       and fn_tax_rate_on(t.id, current_date) is not null
     order by t.code`;

  return (
    <>
      <ErpCrumbs steps={[
        { label: "Sales invoices", href: "/sales/invoices" },
        { label: inv.doc_no as string, href: `/documents/${inv.id}` },
        { label: "Credit note" },
      ]} />
      <div className="page-head">
        <span className="eyebrow">Sales</span>
        <h1>Credit note</h1>
        <HelpHint>
          Reduces what a customer owes without goods coming back &mdash; a
          price agreed differently, a short delivery billed in full, a
          discount settled after the fact.
          <br /><br />
          The invoice is never edited. It keeps its number and its printed
          copy stays true; what it still owes is worked out with this note
          subtracted, the same way a return is.
          <br /><br />
          If the goods are actually coming back, raise a customer return
          instead &mdash; that puts the stock and its cost back too.
        </HelpHint>
      </div>

      <NoteForm
        kind="credit"
        invoice={inv as never}
        taxCodes={taxCodes as never}
        today={new Date().toISOString().slice(0, 10)}
        action={createCreditNote}
      />
    </>
  );
}
