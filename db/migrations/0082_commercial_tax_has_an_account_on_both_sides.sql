-- Commercial tax needs somewhere to land before it can be charged.
--
-- Every document line already carried tax_code_id, tax_amount and
-- gross_amount, and every document a tax_total. The engine wrote zero into
-- all of them, because there was nowhere for the money to go: the chart had
-- "Commercial Tax Payable" for tax charged on a sale, nothing for tax paid on
-- a purchase, and no role pointing at either.
--
-- Tax charged on a sale is money held for the revenue department, never
-- income. Tax paid on a purchase is creditable against it, so it is an asset
-- until it is set off — a trader who books it to expense pays it twice.

-- 1080 Input Commercial Tax, for companies that already exist. New ones get
-- it from db/chart.mjs, which is where this account is defined.
insert into account (company_id, code, name, account_type, is_postable, parent_id)
select c.id, '1080', 'Input Commercial Tax', 'ASSET', true,
       (select a.id from account a
         where a.company_id = c.id and a.account_type = 'ASSET'
           and a.is_postable = false
         order by a.code limit 1)
  from company c
 where not exists (
   select 1 from account a where a.company_id = c.id and a.code = '1080'
 );

-- Two new roles for the two sides of the same tax.
alter table system_account drop constraint if exists system_account_role_check;
alter table system_account add constraint system_account_role_check check (
  role = any (array[
    'GRIR_CLEARING', 'PURCHASE_PRICE_VARIANCE', 'PURCHASE_DISCOUNT_RECEIVED',
    'SALES_DISCOUNT_ALLOWED', 'STOCK_ADJUSTMENT', 'PROMOTION_EXPENSE',
    'FX_GAIN', 'FX_LOSS', 'ROUNDING_DIFFERENCE', 'OPENING_BALANCE_EQUITY',
    'RETAINED_EARNINGS', 'DELIVERY_INCOME', 'CUSTOMER_ADVANCE', 'SUPPLIER_ADVANCE',
    'OUTPUT_TAX', 'INPUT_TAX'
  ])
);

insert into system_account (company_id, role, account_id)
select c.id, r.role, a.id
  from company c
  cross join (values ('OUTPUT_TAX', '7000'), ('INPUT_TAX', '1080')) as r(role, code)
  join account a on a.company_id = c.id and a.code = r.code
 where not exists (
   select 1 from system_account s where s.company_id = c.id and s.role = r.role
 );

-- The 5% code every Myanmar trader charges, alongside the NONE that already
-- exists. Both point at the two roles above rather than carrying accounts of
-- their own, so a company that re-charts does not end up with tax pointing
-- at a deleted account.
update tax_code t
   set output_account_id = (select account_id from system_account s
                             where s.company_id = t.company_id and s.role = 'OUTPUT_TAX'),
       input_account_id  = (select account_id from system_account s
                             where s.company_id = t.company_id and s.role = 'INPUT_TAX')
 where t.rate > 0;

insert into tax_code (company_id, code, name, rate, output_account_id, input_account_id)
select c.id, 'CT5', 'Commercial Tax 5%', 5,
       (select account_id from system_account s where s.company_id = c.id and s.role = 'OUTPUT_TAX'),
       (select account_id from system_account s where s.company_id = c.id and s.role = 'INPUT_TAX')
  from company c
 where not exists (
   select 1 from tax_code t where t.company_id = c.id and t.code = 'CT5'
 );

comment on column document.price_includes_tax is
  'True when unit prices on this document already contain the tax, so tax is extracted from the price rather than added to it.';
