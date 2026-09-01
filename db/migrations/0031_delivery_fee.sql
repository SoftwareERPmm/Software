-- Delivery fee charged to the customer.
--
-- Every delivery can carry a fee, and the money is income the company earns
-- for carrying the goods rather than part of the price of the goods
-- themselves. Keeping it out of Sales matters: gross margin on the product is
-- what tells you whether the trade is worth doing, and folding a transport
-- charge into revenue quietly flatters it.
--
-- Two decisions worth stating, because both could reasonably have gone the
-- other way:
--
--   The fee is a column on the document, not a service item line. A line
--   would need no schema at all and would ride the existing machinery, but
--   nothing would then oblige a delivery to carry one or guarantee it reached
--   the income account rather than whatever the item resolved to. A column
--   makes the charge explicit and its account fixed.
--
--   It is entered on the delivery and posted at the sales invoice, never at
--   the delivery. Revenue in this system is recognised when the customer is
--   billed; the delivery moves stock and recognises cost. Posting a fee at
--   the delivery would be the one place revenue appeared without an invoice
--   behind it, and the receivable it creates would have nothing to age
--   against.

alter table document add column delivery_fee numeric(18,4) not null default 0
    check (delivery_fee >= 0);

comment on column document.delivery_fee is
    'Charge to the customer for delivering the goods. Entered on a DELIVERY, '
    'carried onto the SALES_INVOICE that bills it, and posted there as '
    'Dr AR / Cr the DELIVERY_INCOME account. Never posted at the delivery.';

-- The fee needs an account of its own to land in, resolved the same way every
-- other non-item posting resolves: a named role pointing at whichever account
-- this company's chart uses. Without the role the posting engine has nowhere
-- to send it and would have to guess at a code.
alter table system_account drop constraint system_account_role_check;
alter table system_account add constraint system_account_role_check
    check (role in (
        'GRIR_CLEARING',
        'PURCHASE_PRICE_VARIANCE',
        'PURCHASE_DISCOUNT_RECEIVED',
        'SALES_DISCOUNT_ALLOWED',
        'STOCK_ADJUSTMENT',
        'PROMOTION_EXPENSE',
        'FX_GAIN',
        'FX_LOSS',
        'ROUNDING_DIFFERENCE',
        'OPENING_BALANCE_EQUITY',
        'RETAINED_EARNINGS',
        'DELIVERY_INCOME'
    ));

-- Point it at the company's other-income account where one exists, so an
-- existing database can post a delivery fee straight after migrating rather
-- than erroring until someone visits the settings screen. Charts that use a
-- different account can repoint the role there; charts with no other-income
-- account get nothing here and the engine will say so plainly when a fee is
-- first entered.
insert into system_account (company_id, role, account_id)
select c.id, 'DELIVERY_INCOME', a.id
  from company c
  join account a on a.company_id = c.id
 where a.account_type = 'REVENUE'
   and (a.code = '4100' or lower(a.name) like '%other income%')
   and not exists (
         select 1 from system_account s
          where s.company_id = c.id and s.role = 'DELIVERY_INCOME'
       )
   and a.id = (
         select a2.id from account a2
          where a2.company_id = c.id
            and a2.account_type = 'REVENUE'
            and (a2.code = '4100' or lower(a2.name) like '%other income%')
          order by a2.code
          limit 1
       );
