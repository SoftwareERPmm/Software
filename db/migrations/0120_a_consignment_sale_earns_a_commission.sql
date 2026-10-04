-- A consignment sale earns a commission, not a sale.
--
-- The goods were never the company's. Selling them for 60,000 when the
-- consignor is owed 10,000 is not 60,000 of revenue and 10,000 of cost of
-- sales — it is 50,000 earned for selling someone else's goods and 10,000
-- held for them. Recording it gross put the consignor's money in Sales and
-- an expense in Cost of Goods Sold that was never a cost of anything the
-- company owned, and inflated both the top line and every margin measured
-- against it.
--
-- So the settlement now reclassifies rather than buys:
--
--   Dr Sales (or Deferred Revenue)   the consigned goods' share of the sale
--   Cr 4040 Commission Revenue       what the company keeps
--   Cr 2080 Payable to Consignors    what the consignor is owed
--
-- 2080 is a control account of its own rather than 2000, so what is owed to
-- consignors is never mixed with ordinary supplier bills — even when the same
-- partner is both. A payment clears whichever account each invoice it settles
-- was posted to.

insert into account (company_id, code, name, account_type, is_postable, parent_id)
select c.id, '4040', 'Commission Revenue', 'REVENUE', true,
       (select a.parent_id from account a where a.company_id = c.id and a.code = '4000')
  from company c
 where not exists (select 1 from account a where a.company_id = c.id and a.code = '4040');

insert into account (company_id, code, name, account_type, is_postable, is_control,
                     subledger, parent_id)
select c.id, '2080', 'Payable to Consignors', 'LIABILITY', true, true, 'SUPPLIER',
       (select a.parent_id from account a where a.company_id = c.id and a.code = '2000')
  from company c
 where not exists (select 1 from account a where a.company_id = c.id and a.code = '2080');

alter table system_account drop constraint if exists system_account_role_check;
alter table system_account add constraint system_account_role_check check (
  role = any (array[
    'GRIR_CLEARING', 'PURCHASE_PRICE_VARIANCE', 'PURCHASE_DISCOUNT_RECEIVED',
    'SALES_DISCOUNT_ALLOWED', 'STOCK_ADJUSTMENT', 'PROMOTION_EXPENSE',
    'FX_GAIN', 'FX_LOSS', 'ROUNDING_DIFFERENCE', 'OPENING_BALANCE_EQUITY',
    'RETAINED_EARNINGS', 'DELIVERY_INCOME', 'CUSTOMER_ADVANCE', 'SUPPLIER_ADVANCE',
    'OUTPUT_TAX', 'INPUT_TAX', 'SHIPPED_NOT_INVOICED', 'DEFERRED_REVENUE',
    'COMMISSION_REVENUE', 'CONSIGNOR_PAYABLE'
  ])
);

insert into system_account (company_id, role, account_id)
select c.id, r.role, a.id
  from company c
  cross join (values ('COMMISSION_REVENUE', '4040'), ('CONSIGNOR_PAYABLE', '2080')) r(role, code)
  join account a on a.company_id = c.id and a.code = r.code
 where not exists (
   select 1 from system_account s where s.company_id = c.id and s.role = r.role
 );

-- The advance accounts lost their subledger on any database re-charted by
-- scripts/load-coa.mjs, which derived ownership from the control roles only.
-- 0062 set it once; this puts it back where it went missing.
update account a set subledger = 'CUSTOMER'
  from system_account s
 where s.account_id = a.id and s.role = 'CUSTOMER_ADVANCE' and a.subledger is null;
update account a set subledger = 'SUPPLIER'
  from system_account s
 where s.account_id = a.id and s.role = 'SUPPLIER_ADVANCE' and a.subledger is null;

-- A consumption can now be settled in parts. An invoice billing five of the
-- ten consigned units one delivery drew settles five; the next invoice
-- settles the rest. What is unsettled is what was consumed less whatever
-- standing settlements already cover.
create or replace view v_consignment_unsettled as
select c.company_id,
       c.id as consumption_id,
       c.delivery_document_id,
       c.lot_id,
       (c.qty - coalesce(s.settled, 0))::numeric(18,4) as qty,
       cl.item_id,
       rd.partner_id as consignor_id
  from consignment_lot_consumption c
  join consignment_lot cl on cl.id = c.lot_id
  join document rd on rd.id = cl.receipt_document_id
  left join lateral (
    select sum(sl.qty) as settled
      from consignment_settlement_line sl
      join document sd on sd.id = sl.settlement_document_id
     where sl.consumption_id = c.id and sd.status = 'POSTED'
  ) s on true
 where c.qty - coalesce(s.settled, 0) > 0.0001;

comment on view v_consignment_unsettled is
    'Consigned goods delivered and not yet settled, by remaining quantity — '
    'never settled, settled in part, or settled by a document since voided.';
