-- An allocation only counts while the payment behind it stands.
--
-- v_open_item and v_invoice_status both sum payment_allocation with no regard
-- for the state of the payment that made the allocation. That was harmless
-- while a posted payment could never stop being posted. Voiding one (0037)
-- makes it wrong, and wrong in the worst available way:
--
--   void a supplier payment, and its journal lines are reversed — AP control
--   goes back up and the supplier is owed again. The allocation row stays, so
--   v_open_item still deducts it and the payables aging still shows the bill
--   as settled. The control account says you owe it, the subledger says you
--   do not, and neither looks broken.
--
-- That is the same failure 0023 was written about, arriving from the other
-- direction. The allocation is kept — it is a record of something that was
-- done, and deleting it would lose what the payment had been applied to — but
-- it stops counting once the payment is voided.

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
    d.gross_total - coalesce(a.paid, 0)     as outstanding,
    case
        when coalesce(a.paid, 0) = 0                then 'OPEN'
        when coalesce(a.paid, 0) < d.gross_total    then 'PARTIALLY_PAID'
        else 'PAID'
    end as payment_status,
    case
        when d.due_date is null then null
        else current_date - d.due_date
    end as days_overdue

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
   and d.doc_type in ('SALES_INVOICE', 'PURCHASE_INVOICE');

comment on view v_invoice_status is
    'Every posted invoice with what has been settled against it by payments '
    'that are themselves still posted. OPEN, PARTIALLY_PAID or PAID is '
    'computed from allocations, never stored.';

-- The over-allocation guard has the same blind spot: a voided payment must
-- not go on reserving room against the invoice it no longer settles, or a
-- bill whose payment was voided could never be paid again. Otherwise this is
-- the 0005 function unchanged — same comparison, same message.
create or replace function fn_allocation_within_invoice() returns trigger
language plpgsql as $$
declare
    v_invoice_total numeric(18,4);
    v_allocated     numeric(18,4);
begin
    select gross_total into v_invoice_total
      from document where id = new.invoice_id;

    select coalesce(sum(pa.amount), 0) into v_allocated
      from payment_allocation pa
      join document pay on pay.id = pa.payment_id
     where pa.invoice_id = new.invoice_id
       and pa.id <> new.id
       and pay.status = 'POSTED';

    if abs(v_allocated + new.amount) > abs(v_invoice_total) then
        raise exception
            'Allocation of % would over-apply invoice % (total %, already allocated %)',
            new.amount, new.invoice_id, v_invoice_total, v_allocated;
    end if;

    return new;
end;
$$;
