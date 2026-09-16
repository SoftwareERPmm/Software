-- A delivery fee is earned from a sale
--
-- 0071 moved 4100 Other Income out of revenue, which was right for what 4100
-- mostly is and wrong for one thing inside it. The account was doing two jobs:
-- FX_GAIN and DELIVERY_INCOME both pointed at it, so an exchange gain and a
-- delivery charge landed in the same place and no single position could be
-- right for both.
--
-- A delivery fee is charged to the customer for carrying the goods they just
-- bought. It exists because the sale did, and it is revenue — kept out of 4000
-- Sales because it is not product sales, but above the operating line all the
-- same. It gets 4030 Delivery Income under 4-SA.
--
-- An exchange difference is the other way round: not a cost or income of
-- trading, but what happened to money between agreeing a price and settling
-- it. The gain already sits in 4100 under 4-OI, below operating profit. The
-- loss did not — FX_LOSS pointed at 6110 Miscellaneous Expenses, inside
-- General & Administration, so an exchange loss was absorbed as an operating
-- cost and operating profit carried it. It gets 6400 under a new 6-NO
-- Non-Operating Expenses group, opposite 4-OI.
--
-- Rounding differences stay at 6110. A rounding difference really is a
-- miscellaneous cost of doing business.
--
-- What is already posted stays where it was posted. Delivery fees charged
-- before this sit in 4100 and will read as other income for as long as those
-- documents are read, because a posted journal line is never rewritten. Only
-- what happens next changes.

-- ---------------------------------------------------------------------------
-- The two new accounts, for companies that already exist.

insert into account (company_id, parent_id, code, name, account_type,
                     is_postable, is_control, is_cash_account, is_bank_account)
select c.id,
       (select a.id from account a where a.company_id = c.id and a.code = '4-SA'),
       '4030', 'Delivery Income', 'REVENUE', true, false, false, false
  from company c
 where not exists (
       select 1 from account a where a.company_id = c.id and a.code = '4030');

insert into account (company_id, parent_id, code, name, account_type,
                     is_postable, is_control, is_cash_account, is_bank_account)
select c.id,
       (select a.id from account a where a.company_id = c.id and a.code = '6-EX'),
       '6-NO', 'Non-Operating Expenses', 'EXPENSE', false, false, false, false
  from company c
 where not exists (
       select 1 from account a where a.company_id = c.id and a.code = '6-NO');

insert into account (company_id, parent_id, code, name, account_type,
                     is_postable, is_control, is_cash_account, is_bank_account)
select c.id,
       (select a.id from account a where a.company_id = c.id and a.code = '6-NO'),
       '6400', 'Foreign Exchange Loss', 'EXPENSE', true, false, false, false
  from company c
 where not exists (
       select 1 from account a where a.company_id = c.id and a.code = '6400');

-- ---------------------------------------------------------------------------
-- And where the two roles now post.
--
-- Repointed only where they still aim at the account this migration is moving
-- them off. A company that has already chosen its own delivery-income or
-- exchange-loss account has made a decision, and this does not overrule it.

update system_account s
   set account_id = (select a.id from account a
                      where a.company_id = s.company_id and a.code = '4030')
  from account old
 where s.role = 'DELIVERY_INCOME'
   and old.id = s.account_id
   and old.code = '4100';

update system_account s
   set account_id = (select a.id from account a
                      where a.company_id = s.company_id and a.code = '6400')
  from account old
 where s.role = 'FX_LOSS'
   and old.id = s.account_id
   and old.code = '6110';
