-- A reversal of a close is not itself a close.
--
-- 0094 allowed one standing YEAR_END_CLOSE per year, as
--
--   where doc_type = 'YEAR_END_CLOSE' and status <> 'REVERSED'
--
-- which is right about the original and wrong about the mirror. Voiding
-- writes a reversing document of the same type, against the same year, and
-- it is POSTED — so the index counted it as a second standing close and
-- reopening a year failed on a unique violation.
--
-- The condition wanted is "a close somebody raised", and the thing that
-- distinguishes one is that it reverses nothing.

drop index if exists ux_year_end_close_per_year;

create unique index ux_year_end_close_per_year
  on document (company_id, fiscal_year_id)
  where doc_type = 'YEAR_END_CLOSE'
    and status <> 'REVERSED'
    and reverses_document_id is null;

-- Same correction in the view: after a reopen the mirror is still POSTED, so
-- without this the year reads as closed by a document that undid a close.
create or replace view v_year_end_position as
select fy.id            as fiscal_year_id,
       fy.company_id,
       fy.code,
       fy.start_date,
       fy.end_date,
       fy.status,
       (select count(*) from fiscal_period p
         where p.fiscal_year_id = fy.id and p.status = 'OPEN')        as open_periods,
       (select count(*) from fiscal_period p
         where p.fiscal_year_id = fy.id)                              as periods,
       coalesce((select sum(jl.base_amount)
                   from journal_line jl
                   join journal_entry je on je.id = jl.journal_entry_id
                   join account a on a.id = jl.account_id
                  where jl.company_id = fy.company_id
                    and a.account_type = 'REVENUE'
                    and je.entry_date between fy.start_date and fy.end_date), 0)
                                                                      as revenue_balance,
       coalesce((select sum(jl.base_amount)
                   from journal_line jl
                   join journal_entry je on je.id = jl.journal_entry_id
                   join account a on a.id = jl.account_id
                  where jl.company_id = fy.company_id
                    and a.account_type in ('COGS','EXPENSE')
                    and je.entry_date between fy.start_date and fy.end_date), 0)
                                                                      as cost_balance,
       -coalesce((select sum(jl.base_amount)
                   from journal_line jl
                   join journal_entry je on je.id = jl.journal_entry_id
                   join account a on a.id = jl.account_id
                  where jl.company_id = fy.company_id
                    and a.account_type in ('REVENUE','COGS','EXPENSE')
                    and je.entry_date between fy.start_date and fy.end_date), 0)
                                                                      as result,
       (select d.id from document d
         where d.company_id = fy.company_id and d.fiscal_year_id = fy.id
           and d.doc_type = 'YEAR_END_CLOSE' and d.status <> 'REVERSED'
           and d.reverses_document_id is null
         limit 1)                                                     as closed_by_document_id
  from fiscal_year fy;
