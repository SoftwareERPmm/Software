-- Correct how DELIVERY_INCOME was chosen in 0031.
--
-- 0031 matched the account by code as well as by name:
--
--     where a.account_type = 'REVENUE'
--       and (a.code = '4100' or lower(a.name) like '%other income%')
--
-- That reads as "4100, which is Other Income" only if you are looking at one
-- particular chart. On the customer's chart 4100 is indeed Other Income. On
-- the chart in db/seed.sql, 4100 is Sales Revenue — so the migration pointed
-- delivery income straight at the sales account, which is precisely the
-- account the whole feature exists to keep carriage out of. Revenue would
-- have been overstated by every delivery fee ever charged, and the gross
-- margin on the goods themselves — the number the business is judged on —
-- flattered by the same amount.
--
-- The lesson is narrow and worth writing down: an account code means nothing
-- without the chart it belongs to. Match on the role a name describes, or on
-- an explicit choice, never on a number that happens to be right locally.

-- 1. Undo any mapping that landed on an account whose name does not actually
--    describe other/miscellaneous income. Safe to do bluntly: 0031 shipped in
--    the same batch as this file, there is no UI for setting the role, and so
--    nobody can yet have chosen a mapping by hand that this would discard.
delete from system_account s
 using account a
 where s.account_id = a.id
   and s.role = 'DELIVERY_INCOME'
   and lower(a.name) not like '%other income%'
   and lower(a.name) not like '%misc%income%'
   and lower(a.name) not like '%delivery income%';

-- 2. A chart with no other-income account still needs somewhere for the fee
--    to land, and there is no settings screen to point the role at one. Left
--    unset, a tester charging a delivery fee would hit an error they had no
--    way to clear. So give such a chart the account it is missing, filed
--    under the same parent as the rest of its income and numbered after the
--    last of them rather than at a hardcoded code that might be taken.
insert into account (company_id, parent_id, code, name, account_type, is_postable)
select c.id,
       (select a2.parent_id from account a2
         where a2.company_id = c.id and a2.account_type = 'REVENUE' and a2.is_postable
         order by a2.code limit 1),
       (select lpad((max(a3.code::bigint) + 100)::text, length(max(a3.code)), '0')
          from account a3
         where a3.company_id = c.id and a3.account_type = 'REVENUE'
           and a3.code ~ '^[0-9]+$'),
       'Other Income',
       'REVENUE',
       true
  from company c
 where not exists (
         select 1 from system_account s
          where s.company_id = c.id and s.role = 'DELIVERY_INCOME'
       )
   -- only for charts whose revenue codes are plain numbers, so the generated
   -- code above is meaningful; anything else is left for a human to decide
   and exists (
         select 1 from account a4
          where a4.company_id = c.id and a4.account_type = 'REVENUE'
            and a4.code ~ '^[0-9]+$'
       )
   and not exists (
         select 1 from account a5
          where a5.company_id = c.id and lower(a5.name) like '%other income%'
       );

-- 3. Point the role at whichever other-income account each company now has.
insert into system_account (company_id, role, account_id)
select c.id, 'DELIVERY_INCOME', a.id
  from company c
  join lateral (
        select a2.id from account a2
         where a2.company_id = c.id
           and a2.account_type = 'REVENUE'
           and a2.is_postable
           and lower(a2.name) like '%other income%'
         order by a2.code
         limit 1
  ) a on true
 where not exists (
         select 1 from system_account s
          where s.company_id = c.id and s.role = 'DELIVERY_INCOME'
       );
