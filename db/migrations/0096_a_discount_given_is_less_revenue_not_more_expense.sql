-- A discount given is less revenue, not more expense.
--
-- The chart carried two accounts for the same event, classified opposite
-- ways and neither ever used:
--
--   4020  Sales Discount     REVENUE   (contra-revenue)
--   6300  Discount Allowed   EXPENSE
--
-- and the SALES_DISCOUNT_ALLOWED slot pointed at the expense one. Money was
-- never spent on a discount — less of it was collected — so the revenue-side
-- account is the correct home and the expense-side one is a duplicate that
-- would have overstated both revenue and costs had either ever been posted
-- to.
--
-- Nothing about posting changes. Sales still use the net method: a line
-- discounted 10% records revenue of 90, and the discount stays on
-- document_line where a report can still count it. This only stops the chart
-- of accounts describing a treatment the engine does not use, which is the
-- kind of thing that makes an accountant distrust everything else on the
-- page.
--
-- 6300 is deactivated rather than deleted. It is referenced by nothing today,
-- but an account that ever appeared in a trial balance should never vanish
-- from one — and if some company out there did post to it, deleting would
-- orphan those lines while deactivating leaves them readable.

do $$
declare
  c record;
begin
  for c in select id from company loop
    -- Point the slot at the contra-revenue account. Only where 4020 exists:
    -- a company re-charted from an older list might not have it, and a slot
    -- pointing nowhere is worse than one pointing at the wrong place.
    update system_account sa
       set account_id = (select a.id from account a
                          where a.company_id = c.id and a.code = '4020')
     where sa.company_id = c.id
       and sa.role = 'SALES_DISCOUNT_ALLOWED'
       and exists (select 1 from account a
                    where a.company_id = c.id and a.code = '4020');

    -- Retire the duplicate, but only if nothing was ever posted to it.
    update account a
       set is_active = false
     where a.company_id = c.id
       and a.code = '6300'
       and not exists (select 1 from journal_line jl where jl.account_id = a.id);
  end loop;
end $$;

-- What was given away, by kind, from the line columns the engine already
-- fills. This is the answer the general ledger would have given under the
-- gross method — without changing how anything posts.
--
-- Three separate discounts can apply to one line and they are kept apart on
-- purpose: a price agreed with one customer, a volume break earned by the
-- size of the order, and a discount applied across the whole invoice are
-- different decisions by different people, and rolling them into one figure
-- loses the only thing worth knowing about them.
create or replace view v_discount_given as
select d.company_id,
       d.id                as document_id,
       d.doc_no,
       d.doc_type,
       d.posting_date,
       d.partner_id,
       p.name              as partner_name,
       dl.id               as document_line_id,
       dl.item_id,
       i.code              as item_code,
       i.name              as item_name,
       coalesce(dl.discount_amount, 0)         as line_discount,
       coalesce(dl.volume_discount_amount, 0)  as volume_discount,
       coalesce(dl.invoice_discount_amount, 0) as invoice_discount,
       coalesce(dl.discount_amount, 0)
         + coalesce(dl.volume_discount_amount, 0)
         + coalesce(dl.invoice_discount_amount, 0)                as total_discount,
       dl.net_amount,
       -- What the line would have been at full price, so a discount can be
       -- read as a proportion of what was asked rather than of what was paid.
       dl.net_amount
         + coalesce(dl.discount_amount, 0)
         + coalesce(dl.volume_discount_amount, 0)
         + coalesce(dl.invoice_discount_amount, 0)                as gross_before_discount
  from document_line dl
  join document d on d.id = dl.document_id
  left join business_partner p on p.id = d.partner_id
  left join item i on i.id = dl.item_id
 where d.doc_type in ('SALES_INVOICE', 'SALES_ORDER')
   and d.status = 'POSTED'
   and d.reverses_document_id is null
   and (coalesce(dl.discount_amount, 0)
        + coalesce(dl.volume_discount_amount, 0)
        + coalesce(dl.invoice_discount_amount, 0)) <> 0;
