-- Other income is not revenue
--
-- 4100 Other Income hung under 4-SA Sales, inside REVENUE, so a delivery
-- charge or an exchange gain was counted as trading income. That inflated the
-- top line, inflated gross profit with it, and quietly widened the base every
-- "% of revenue" was measured against — three figures wrong from one wrong
-- parent.
--
-- It moves to a group of its own, still REVENUE by nature because it is
-- credit-normal money coming in, but no longer part of what the business sold.
-- The income statement reads the two groups as separate sections, which is
-- what lets Operating profit exist as a figure rather than as a second name
-- for net income:
--
--     Revenue                 trading only
--   − Cost of goods sold
--   = Gross profit
--   − Operating expenses
--   = Operating profit
--   + Other income
--   = Net income
--
-- Nothing posted changes. A parent decides where an account is reported, not
-- what may be written to it, and 4100 keeps both its roles — FX_GAIN and
-- DELIVERY_INCOME resolve by code. No journal line moves; the accounts the
-- ledger already holds simply add up in a truer order.
--
-- db/chart.mjs and db/seed.sql carry the same change, so a company set up
-- after this has the group from the start rather than needing the migration.

insert into account (company_id, parent_id, code, name, account_type,
                     is_postable, is_control, is_cash_account, is_bank_account)
select c.id, null, '4-OI', 'Other Income', 'REVENUE', false, false, false, false
  from company c
 where not exists (
       select 1 from account a where a.company_id = c.id and a.code = '4-OI');

-- Reparented only where it is still sitting under the sales group: a company
-- that has already moved it, or filed it somewhere deliberate, is left alone.
update account child
   set parent_id = (select a.id from account a
                     where a.company_id = child.company_id and a.code = '4-OI')
  from account parent
 where child.company_id = parent.company_id
   and child.parent_id = parent.id
   and child.code = '4100'
   and parent.code = '4-SA';
