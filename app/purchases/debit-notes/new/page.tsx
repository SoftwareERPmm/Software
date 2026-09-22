import { notFound } from "next/navigation";
import { sql } from "@/lib/db";
import { createDebitNote } from "@/lib/actions";
import { NoteForm } from "@/components/note-form";
import { ErpCrumbs } from "@/components/erp-worklist";
import { HelpHint } from "@/components/help-hint";

export default async function NewDebitNote({
  searchParams,
}: {
  searchParams: Promise<{ bill?: string }>;
}) {
  const { bill: invoice } = await searchParams;
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
           and d.doc_type = 'PURCHASE_INVOICE' and d.status = 'POSTED'`
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
        { label: "Purchase invoices", href: "/purchases/invoices" },
        { label: inv.doc_no as string, href: `/documents/${inv.id}` },
        { label: "Debit note" },
      ]} />
      <div className="page-head">
        <span className="eyebrow">Purchases</span>
        <h1>Debit note</h1>
        <HelpHint>
          Reduces what you owe a supplier without goods going back &mdash;
          a short delivery billed in full, a price agreed differently, a
          deduction the supplier has accepted.
          <br /><br />
          The bill is never edited. It keeps its number and the supplier's
          copy stays true; what you still owe is worked out with this note
          subtracted, the same way a supplier return is.
          <br /><br />
          If the goods are actually going back, raise a supplier return
          instead &mdash; that takes the stock and its cost off too.
        </HelpHint>
      </div>

      <NoteForm
        kind="debit"
        invoice={inv as never}
        taxCodes={taxCodes as never}
        today={new Date().toISOString().slice(0, 10)}
        action={createDebitNote}
      />
    </>
  );
}
