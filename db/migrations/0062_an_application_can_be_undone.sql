-- An advance application has to be undoable, and it was not.
--
-- 0061 put the application's journal on its own AA document but left its
-- allocation pointing only at the original receipt, with nothing recording
-- which application had created it. Two things followed, both of which put the
-- ledger and the subledger out of step:
--
--   Voiding the application reversed its entry — receivables went back up —
--   while the allocation carried on counting, so the invoice still read as
--   paid.
--
--   Voiding the receipt stopped its allocation counting, so the invoice
--   reopened, while the application's entry stood: receivables credited for
--   money that was no longer there.
--
-- 0040 already solved the general shape of this for ordinary payments: an
-- allocation counts only while the payment it belongs to is posted, so voiding
-- a payment un-settles its invoices without anything having to remember to.
-- The same rule extends to applications once the allocation says which one
-- made it.
--
-- Voiding the receipt underneath a live application is a different case and
-- cannot be handled by a view: the application's entry would have to be
-- reversed too, and voiding one document must not quietly void another. That
-- one is refused in planVoid, with the application named.

alter table payment_allocation
    add column if not exists applied_by_document_id uuid references document(id);

comment on column payment_allocation.applied_by_document_id is
    'The advance application that created this allocation, where one did. '
    'Null for an allocation written by the payment itself at the moment it '
    'was posted, which is every ordinary settlement.';

create index if not exists payment_allocation_applied_by_idx
    on payment_allocation (applied_by_document_id)
 where applied_by_document_id is not null;

-- ---------------------------------------------------------------------------
-- An allocation counts while everything that made it still stands.

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
          -- The application, where one made this allocation. Void it and the
          -- allocation stops counting, which is what puts the invoice back to
          -- owing what its reversed entry says it owes.
          left join document app on app.id = pa.applied_by_document_id
         where pay.status = 'POSTED'
           and (pa.applied_by_document_id is null or app.status = 'POSTED')
         group by pa.invoice_id
  ) al on al.invoice_id = d.id
 where d.status   = 'POSTED'
   and d.doc_type in ('SALES_INVOICE', 'PURCHASE_INVOICE')
   and not exists (
         select 1 from document orig
          where orig.reversed_by_document_id = d.id
       )
   and d.gross_total - coalesce(al.allocated, 0) <> 0;

-- The same rule on the other side: money is back on account the moment the
-- application that spent it is reversed. Dropped rather than replaced: it
-- gains a column in the middle, and Postgres will not rename its way there.
drop view if exists v_partner_advance;

create view v_partner_advance as
select
    d.company_id,
    d.partner_id,
    p.code  as partner_code,
    p.name  as partner_name,
    d.doc_type,
    d.id    as payment_id,
    d.doc_no,
    d.doc_date,
    d.location_id,
    d.gross_total                                as received,
    coalesce(al.applied, 0)                      as applied,
    d.gross_total - coalesce(al.applied, 0)      as available
  from document d
  join business_partner p on p.id = d.partner_id
  left join (
        select pa.payment_id, sum(pa.amount) as applied
          from payment_allocation pa
          join document inv on inv.id = pa.invoice_id
          left join document app on app.id = pa.applied_by_document_id
         where inv.status = 'POSTED'
           and (pa.applied_by_document_id is null or app.status = 'POSTED')
         group by pa.payment_id
  ) al on al.payment_id = d.id
 where d.status = 'POSTED'
   and d.doc_type in ('CUSTOMER_RECEIPT', 'SUPPLIER_PAYMENT')
   and d.gross_total - coalesce(al.applied, 0) > 0.0001;

comment on view v_partner_advance is
    'Money received or paid that no invoice has claimed yet, per partner and '
    'per document — and the branch that took it, since that is where it has '
    'to be cleared from when it is finally applied.';

-- ---------------------------------------------------------------------------
-- The advance accounts belong to their subledger, like every other balance
-- that is really a per-partner figure.
--
-- Without this a hand-typed journal could move the general-ledger balance of
-- customer advances without touching a single advance record, and the two
-- would disagree with nothing to say which was right. The guard added in 0045
-- already refuses exactly that for receivables and payables; these are the
-- same kind of balance and get the same protection.
--
-- Matched by role rather than by code. 0061 mapped the roles to whatever
-- account happened to carry 1070 and 2060, which in a chart that had already
-- used those codes for something else would have pointed the advance postings
-- at an unrelated account.

update account a
   set subledger = 'CUSTOMER'
  from system_account s
 where s.account_id = a.id and s.role = 'CUSTOMER_ADVANCE' and a.subledger is null;

update account a
   set subledger = 'SUPPLIER'
  from system_account s
 where s.account_id = a.id and s.role = 'SUPPLIER_ADVANCE' and a.subledger is null;

-- And say so loudly if 0061 mapped a role onto an account that was already
-- being used for something else. Better a failed migration than advances
-- quietly accumulating in Prepaid Expenses.
do $$
declare
    wrong record;
begin
    for wrong in
        select c.name as company, s.role, a.code, a.name, a.account_type
          from system_account s
          join account a on a.id = s.account_id
          join company c on c.id = s.company_id
         where s.role in ('CUSTOMER_ADVANCE', 'SUPPLIER_ADVANCE')
           and (
             (s.role = 'CUSTOMER_ADVANCE' and (a.account_type <> 'LIABILITY' or a.name <> 'Customer Advances'))
             or (s.role = 'SUPPLIER_ADVANCE' and (a.account_type <> 'ASSET' or a.name <> 'Supplier Advances'))
           )
    loop
        raise exception
            '% has % pointing at % (% %), which is not an advances account. '
            'Point the role at the right account before applying this.',
            wrong.company, wrong.role, wrong.code, wrong.account_type, wrong.name;
    end loop;
end $$;
