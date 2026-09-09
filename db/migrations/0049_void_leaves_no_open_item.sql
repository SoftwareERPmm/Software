-- A voided invoice leaves nothing owed. It was leaving the amount owed, backwards.
--
-- Voiding marks the original REVERSED and posts a reversing document that
-- cancels it — for a purchase invoice, another PURCHASE_INVOICE carrying the
-- negative of the original. Both views then filter on `d.status = 'POSTED'`,
-- which drops the original and keeps the reversal, so what should have netted
-- to nil netted to minus the invoice:
--
--     owed after posting   5,000
--     owed after voiding  -5,000
--
-- Reproduced on 2026-09-07 on an ordinary purchase invoice with nothing else
-- involved. It was found on a consignment settlement, where the consequence
-- is worse than a wrong figure on a screen: the payables list says the
-- consignor owes the shop 50,000, and paying anyone from that is a real
-- payment against an imaginary debt.
--
-- A reversal is not an open item. It exists only to cancel one, and the
-- document it cancels is already excluded. Neither belongs in a list of what
-- is owed, and neither belongs in an aged balance.

create or replace view v_open_item as
select
    d.company_id,
    d.id          as document_id,
    d.doc_type,
    d.doc_no,
    d.partner_id,
    p.code        as partner_code,
    p.name        as partner_name,
    d.posting_date,
    d.due_date,
    d.currency,
    d.gross_total,
    coalesce(al.allocated, 0)                as allocated,
    d.gross_total - coalesce(al.allocated, 0) as outstanding,
    case when d.due_date is null then null
         else current_date - d.due_date end   as days_overdue,
    case
        when d.due_date is null            then 'CURRENT'
        when current_date <= d.due_date    then 'CURRENT'
        when current_date - d.due_date <= 30 then '1-30'
        when current_date - d.due_date <= 60 then '31-60'
        when current_date - d.due_date <= 90 then '61-90'
        else '90+'
    end as aging_bucket
  from document d
  join business_partner p on p.id = d.partner_id
  left join (
        select pa.invoice_id, sum(pa.amount) as allocated
          from payment_allocation pa
          join document pay on pay.id = pa.payment_id
         where pay.status = 'POSTED'
         group by pa.invoice_id
  ) al on al.invoice_id = d.id
 where d.status   = 'POSTED'
   and d.doc_type in ('SALES_INVOICE', 'PURCHASE_INVOICE')
   -- The other half of a void. Its counterpart left by the status filter
   -- above; on its own it is a negative balance owed to nobody.
   and not exists (
         select 1 from document orig
          where orig.reversed_by_document_id = d.id
       )
   and d.gross_total - coalesce(al.allocated, 0) <> 0;

create or replace view v_invoice_status as
select
    d.company_id,
    d.id        as document_id,
    d.doc_type,
    d.doc_no,
    d.partner_id,
    p.code      as partner_code,
    p.name      as partner_name,
    d.posting_date,
    d.due_date,
    d.currency,
    d.gross_total,
    coalesce(a.paid, 0)                    as paid,
    d.gross_total - coalesce(a.paid, 0)    as outstanding,
    case
        when coalesce(a.paid, 0) = 0                    then 'OPEN'
        when coalesce(a.paid, 0) >= d.gross_total       then 'PAID'
        else 'PARTIALLY_PAID'
    end as payment_status,
    case when d.due_date is null then null
         else current_date - d.due_date end as days_overdue

  from document d
  join business_partner p on p.id = d.partner_id
  left join (
        select pa.invoice_id, sum(pa.amount) as paid
          from payment_allocation pa
          join document pay on pay.id = pa.payment_id
         where pay.status = 'POSTED'
         group by pa.invoice_id
  ) a on a.invoice_id = d.id
 where d.status = 'POSTED'
   and d.doc_type in ('SALES_INVOICE', 'PURCHASE_INVOICE')
   and not exists (
         select 1 from document orig
          where orig.reversed_by_document_id = d.id
       );

comment on view v_open_item is
    'What is still owed, either way. Excludes a voided invoice and the '
    'reversal that voided it: neither is owed to anyone.';
