-- Somewhere for revenue to wait when the goods have not gone.
--
-- The mirror of 1090. That account holds the cost of goods that left and
-- were never billed; this one holds the revenue of goods that were billed
-- and never left. See docs/03-decisions.md, D9.
--
-- An invoice raised ahead of the goods creates a receivable — the customer
-- owes the money either way — but it has not earned anything yet, and
-- posting it to Sales puts revenue in a month with no cost against it,
-- which is the mismatch D8 spent its whole length removing.
--
-- The tax does not wait with it. Commercial tax is due because an invoice
-- was raised, not because goods moved, so output tax posts at the invoice
-- and stays there.

insert into account (company_id, code, name, account_type, is_postable, parent_id)
select c.id, '2070', 'Deferred Revenue', 'LIABILITY', true,
       (select a.id from account a
         where a.company_id = c.id and a.account_type = 'LIABILITY'
           and a.is_postable = false
         order by a.code limit 1)
  from company c
 where not exists (
   select 1 from account a where a.company_id = c.id and a.code = '2070'
 );

alter table system_account drop constraint if exists system_account_role_check;
alter table system_account add constraint system_account_role_check check (
  role = any (array[
    'GRIR_CLEARING', 'PURCHASE_PRICE_VARIANCE', 'PURCHASE_DISCOUNT_RECEIVED',
    'SALES_DISCOUNT_ALLOWED', 'STOCK_ADJUSTMENT', 'PROMOTION_EXPENSE',
    'FX_GAIN', 'FX_LOSS', 'ROUNDING_DIFFERENCE', 'OPENING_BALANCE_EQUITY',
    'RETAINED_EARNINGS', 'DELIVERY_INCOME', 'CUSTOMER_ADVANCE', 'SUPPLIER_ADVANCE',
    'OUTPUT_TAX', 'INPUT_TAX', 'SHIPPED_NOT_INVOICED', 'DEFERRED_REVENUE'
  ])
);

insert into system_account (company_id, role, account_id)
select c.id, 'DEFERRED_REVENUE', a.id
  from company c
  join account a on a.company_id = c.id and a.code = '2070'
 where not exists (
   select 1 from system_account s
    where s.company_id = c.id and s.role = 'DEFERRED_REVENUE'
 );

comment on column document.to_deliver is
  'The goods follow the invoice. Revenue waits in Deferred Revenue until the delivery recognises it — see docs/03-decisions.md D9.';
