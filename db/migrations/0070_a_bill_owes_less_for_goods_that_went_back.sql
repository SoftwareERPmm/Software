-- A bill owes less for goods that went back
--
-- Return six cartons of a bill for twenty-two and the ledger is right: the
-- payables control account comes down by twelve thousand, because the return
-- posts against it. The sub-ledger is not. v_open_item and v_invoice_status
-- both read what is still owed as gross_total less allocations, and an
-- allocation is only ever written by a payment — so the bill went on showing
-- its full amount outstanding, aged as though nothing had happened, and could
-- have been paid in full for goods that were sent back.
--
-- Measured before this ran: AP control 478,000, sum of open bills 490,000,
-- apart by exactly the return.
--
-- Derived, not stored. The return already records which invoice it is against;
-- writing a payment_allocation row for it would put a second copy of that fact
-- in a table named for payments, and leave voiding a return having to
-- remember to take it back out. Read from the document instead and a voided
-- return stops counting the moment its status changes.
--
-- A second thing this turned up, once payables were being checked at all.
-- A void or a correction reverses a document by posting its mirror image, and
-- the original drops out of the sub-ledger because its status stops being
-- POSTED. The mirror does not: it is a posted document of the same type, so a
-- reversal for minus sixty thousand sat in the open items as a credit nobody
-- owed, while the plus sixty thousand it cancels had already left. The
-- general ledger nets the pair to zero; the sub-ledger kept one half of it.
-- Both halves leave now, which is what makes them agree.
--
-- A third, found by the void suite once the first two stopped masking it.
-- Voiding a payment is supposed to put the bill back in the aging — lib/void.ts
-- says as much where it refuses to void a receipt whose money has been spent:
-- "voiding the receipt would stop its allocations counting, so the invoices
-- would reopen". They did not stop counting. Both views summed
-- payment_allocation without ever asking whether the payment still stood, so a
-- voided payment went on settling a bill that nobody had paid, and the bill
-- stayed PAID and out of the aging for good.
--
-- Three exclusions, each for a reason:
--   status POSTED            — a draft or voided return owes nothing back
--   reversed_by_document_id  — a return that has been voided is undone
--   reverses_document_id     — the reversal itself is not a second return
--
-- A return against a goods receipt is not part of this. It clears the accrual
-- the receipt raised and never touches an invoice, so it does not match the
-- join at all — which is the behaviour, not an omission.
--
-- Versions are resolved on both sides with fn_current_document: an invoice
-- corrected after a return was made against it is still the invoice that
-- return reduces.

-- ---------------------------------------------------------------------------
-- What each invoice still owes.

create or replace view v_invoice_status as
select d.company_id,
       d.id as document_id,
       d.doc_type,
       d.doc_no,
       d.partner_id,
       p.code as partner_code,
       p.name as partner_name,
       d.posting_date,
       d.due_date,
       d.currency,
       d.gross_total,
       coalesce(a.paid, 0::numeric) as paid,
       (d.gross_total - coalesce(a.paid, 0::numeric) - coalesce(r.returned, 0::numeric))
         as outstanding,
       case
           when coalesce(a.paid, 0::numeric) = 0::numeric
                and coalesce(r.returned, 0::numeric) < d.gross_total then 'OPEN'
           -- Measured against what is actually owed, so a bill settled partly
           -- by a return and partly by cash reads as paid rather than as
           -- forever short by the credit.
           when coalesce(a.paid, 0::numeric)
                >= (d.gross_total - coalesce(r.returned, 0::numeric)) then 'PAID'
           else 'PARTIALLY_PAID'
       end as payment_status,
       case
           when d.due_date is null then null::integer
           else (current_date - d.due_date)
       end as days_overdue,
       coalesce(r.returned, 0::numeric) as returned
  from document d
  join business_partner p on p.id = d.partner_id
  left join (
        -- Only money that is still paid. A voided payment's allocations stay
        -- on the row that recorded them; what stops them counting is the
        -- payment's own status, which nothing here used to ask about.
        select pa.invoice_id, sum(pa.amount) as paid
          from payment_allocation pa
          join document pay on pay.id = pa.payment_id
         where pay.status = 'POSTED'
           and pay.reversed_by_document_id is null
         group by pa.invoice_id
  ) a on a.invoice_id = d.id
  left join (
        select fn_current_document(rr.source_document_id) as invoice_id,
               sum(rr.gross_total) as returned
          from document rr
         where rr.doc_type in ('SALES_RETURN', 'PURCHASE_RETURN')
           and rr.status = 'POSTED'
           and rr.reversed_by_document_id is null
           and rr.reverses_document_id is null
           and rr.source_document_id is not null
         group by 1
  ) r on r.invoice_id = fn_current_document(d.id)
 where d.status = 'POSTED'
   and d.doc_type in ('SALES_INVOICE', 'PURCHASE_INVOICE')
   -- The mirror image of a document that has been voided or corrected. The
   -- document it reverses has already left on status; this is the other half.
   and d.reverses_document_id is null;

-- ---------------------------------------------------------------------------
-- The same figure, for aging and the control-account check.

create or replace view v_open_item as
select d.company_id,
       d.id as document_id,
       d.doc_type,
       d.doc_no,
       d.partner_id,
       p.code as partner_code,
       p.name as partner_name,
       d.posting_date,
       d.due_date,
       d.currency,
       d.gross_total,
       coalesce(al.allocated, 0::numeric) as allocated,
       (d.gross_total - coalesce(al.allocated, 0::numeric) - coalesce(r.returned, 0::numeric))
         as outstanding,
       case
           when d.due_date is null then null::integer
           else (current_date - d.due_date)
       end as days_overdue,
       case
           when d.due_date is null then 'CURRENT'
           when current_date <= d.due_date then 'CURRENT'
           when (current_date - d.due_date) <= 30 then '1-30'
           when (current_date - d.due_date) <= 60 then '31-60'
           when (current_date - d.due_date) <= 90 then '61-90'
           else '90+'
       end as aging_bucket,
       coalesce(r.returned, 0::numeric) as returned
  from document d
  join business_partner p on p.id = d.partner_id
  left join (
        -- Only money that is still paid. A voided payment's allocations stay
        -- on the row that recorded them; what stops them counting is the
        -- payment's own status, which nothing here used to ask about.
        select pa.invoice_id, sum(pa.amount) as allocated
          from payment_allocation pa
          join document pay on pay.id = pa.payment_id
         where pay.status = 'POSTED'
           and pay.reversed_by_document_id is null
         group by pa.invoice_id
  ) al on al.invoice_id = d.id
  left join (
        select fn_current_document(rr.source_document_id) as invoice_id,
               sum(rr.gross_total) as returned
          from document rr
         where rr.doc_type in ('SALES_RETURN', 'PURCHASE_RETURN')
           and rr.status = 'POSTED'
           and rr.reversed_by_document_id is null
           and rr.reverses_document_id is null
           and rr.source_document_id is not null
         group by 1
  ) r on r.invoice_id = fn_current_document(d.id)
 where d.status = 'POSTED'
   and d.doc_type in ('SALES_INVOICE', 'PURCHASE_INVOICE')
   and d.reverses_document_id is null
   -- A bill fully settled by a credit leaves the open items, the same way one
   -- settled by cash does.
   and (d.gross_total - coalesce(al.allocated, 0::numeric)
                      - coalesce(r.returned, 0::numeric)) <> 0::numeric;

-- ---------------------------------------------------------------------------
-- And the check that would have caught it, which only ever looked at one side.
--
-- Receivables were reconciled against the sub-ledger and payables were not, so
-- the divergence above could sit in the books indefinitely without anything
-- saying so. There are no sales returns in the test data at all, which is why
-- the AR half reported clean throughout: it was never exercised, not proven.

create or replace view v_check_control_reconciliation as
with gl as (
    select jl.company_id,
           case when a.account_type = 'ASSET' then 'AR' else 'AP' end as side,
           -- A payable is a credit balance; stated positive so it compares
           -- with a sub-ledger that counts what is owed, not its sign.
           case when a.account_type = 'ASSET'
                then sum(jl.base_amount) else -sum(jl.base_amount) end as gl_balance
      from journal_line jl
      join account a on a.id = jl.account_id
     where a.is_control
       and a.account_type in ('ASSET', 'LIABILITY')
     group by jl.company_id, a.account_type
), sub as (
    select company_id,
           case when doc_type = 'SALES_INVOICE' then 'AR' else 'AP' end as side,
           sum(outstanding) as sub_balance
      from v_open_item
     group by company_id, doc_type
)
select gl.company_id,
       gl.side,
       gl.gl_balance,
       coalesce(sub.sub_balance, 0::numeric) as sub_balance,
       (gl.gl_balance - coalesce(sub.sub_balance, 0::numeric)) as difference
  from gl
  left join sub on sub.company_id = gl.company_id and sub.side = gl.side
 where gl.gl_balance <> coalesce(sub.sub_balance, 0::numeric);

comment on view v_check_control_reconciliation is
    'Both control accounts against their sub-ledgers. Any row is a discrepancy: '
    'the general ledger and the list of open invoices disagree about what is '
    'owed. Payables were added in 0070, along with the returns that made them '
    'disagree.';

-- ---------------------------------------------------------------------------
-- Rebuilt because it reads outstanding straight out of v_invoice_status, and
-- that figure has changed underneath it. Restated in full so the dependency is
-- recreated rather than left pointing at the old shape.
--
-- In full means in full: 0013 created this view and 0020 added due_soon and
-- credit_limit to it, joining business_partner so the Receivables and Payables
-- rollups get everything from one row. Restating only 0013's columns would
-- drop those two -- which Postgres refuses outright, since create or replace
-- may append columns but never remove them. So this carries 0020's shape
-- forward, and the figures underneath it are the corrected ones.

create or replace view v_partner_balance as
select
    v.company_id,
    v.partner_id,
    v.partner_code,
    v.partner_name,
    v.doc_type,
    count(*) filter (where v.outstanding <> 0)::int as open_invoices,
    sum(v.gross_total)                              as invoiced,
    sum(v.paid)                                     as paid,
    sum(v.outstanding)                              as outstanding,
    sum(v.outstanding) filter (
        where v.due_date is not null and v.days_overdue > 0
    )                                               as overdue,
    sum(v.outstanding) filter (
        where v.due_date is not null
          and v.days_overdue <= 0
          and v.due_date <= current_date + 7
    )                                               as due_soon,
    max(p.credit_limit)                             as credit_limit

  from v_invoice_status v
  join business_partner p on p.id = v.partner_id
 group by v.company_id, v.partner_id, v.partner_code, v.partner_name, v.doc_type
having sum(v.outstanding) <> 0;

comment on view v_partner_balance is
    'What each partner owes or is owed, rolled up from open invoices. '
    'due_soon is outstanding and not yet overdue but due within a week; '
    'credit_limit is carried through from business_partner for the same '
    'reason partner_name is -- one row has everything the summary needs. '
    'Outstanding is net of returns and ignores reversed documents (0070).';
