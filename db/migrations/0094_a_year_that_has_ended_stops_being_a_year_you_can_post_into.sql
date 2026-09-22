-- A year that has ended stops being a year you can post into.
--
-- Until now nothing closed a fiscal year. The lock that refuses a posting
-- into a shut period exists and is enforced by a trigger — but every period
-- has always been OPEN, and no screen or function could change that. So the
-- enforcement was real and unreachable.
--
-- Closing does two things that have to happen together:
--
--   1. The profit and loss accounts are emptied into retained earnings. A
--      revenue account is a record of one year's trading; carried into the
--      next it would make April's income statement open with March's sales.
--      Retained earnings is where the result goes to stop being this year's
--      and start being the company's.
--
--   2. Every period in the year is shut, so the figure just calculated
--      cannot be falsified by a later posting dated into it.
--
-- Doing only the first is the trap: a close that leaves the year open lets
-- somebody book a March invoice in June, and retained earnings is then
-- quietly wrong with nothing to show for it.
--
-- The close is itself a document with a journal entry, not a status flag and
-- a recalculation. It can be read, printed and reversed like anything else,
-- and reopening a year is voiding it — not editing history.

alter table document drop constraint if exists document_doc_type_check;
alter table document add constraint document_doc_type_check check (
  doc_type = any (array[
    'PURCHASE_ORDER','GOODS_RECEIPT','PURCHASE_INVOICE','PURCHASE_RETURN',
    'SUPPLIER_PAYMENT','SALES_ORDER','DELIVERY','SALES_INVOICE','SALES_RETURN',
    'CUSTOMER_RECEIPT','STOCK_ADJUSTMENT','STOCK_TRANSFER','CASH_VOUCHER',
    'BANK_VOUCHER','JOURNAL_VOUCHER','CASH_TRANSFER','OPENING_BALANCE',
    'CONSIGNMENT_RECEIPT','CONSIGNMENT_SETTLEMENT','ADVANCE_APPLICATION',
    'CREDIT_NOTE','DEBIT_NOTE',
    'YEAR_END_CLOSE'
  ])
);

-- One standing close per year. A reversed one does not count, which is what
-- makes reopening and closing again possible; two live ones would double the
-- result into equity.
create unique index if not exists ux_year_end_close_per_year
  on document (company_id, fiscal_year_id)
  where doc_type = 'YEAR_END_CLOSE' and status <> 'REVERSED';

create or replace function fn_document_prefix(p_type text, p_direction text)
returns text language sql immutable as $$
    select case
        when p_type = 'CASH_VOUCHER' and p_direction = 'OUT' then 'P'
        when p_type = 'CASH_VOUCHER'                         then 'R'
        when p_type = 'BANK_VOUCHER' and p_direction = 'OUT' then 'BP'
        when p_type = 'BANK_VOUCHER'                         then 'BR'

        when p_type = 'CUSTOMER_RECEIPT'    then 'CR'
        when p_type = 'SUPPLIER_PAYMENT'    then 'CP'
        when p_type = 'JOURNAL_VOUCHER'     then 'J'
        when p_type = 'SALES_INVOICE'       then 'DS'
        when p_type = 'SALES_RETURN'        then 'SR'
        when p_type = 'PURCHASE_INVOICE'    then 'DP'
        when p_type = 'PURCHASE_RETURN'     then 'PR'
        when p_type = 'STOCK_TRANSFER'      then 'ST'
        when p_type = 'GOODS_RECEIPT'       then 'STR'
        when p_type = 'DELIVERY'            then 'SI'
        when p_type = 'STOCK_ADJUSTMENT'    then 'SAJ'
        when p_type = 'CREDIT_NOTE'         then 'CN'
        when p_type = 'DEBIT_NOTE'          then 'DN'

        when p_type = 'PURCHASE_ORDER'      then 'PO'
        when p_type = 'SALES_ORDER'         then 'SO'
        when p_type = 'CASH_TRANSFER'       then 'CT'
        when p_type = 'OPENING_BALANCE'     then 'OB'
        when p_type = 'CONSIGNMENT_RECEIPT' then 'CNR'
        when p_type = 'DELIVERY_TRIP'       then 'TRP'
        when p_type = 'BANK_STATEMENT'      then 'BST'

        -- YEC, not YE: a two-letter prefix would collide with nothing today
        -- and with the first three-letter type somebody adds tomorrow.
        when p_type = 'YEAR_END_CLOSE'      then 'YEC'
        else 'GEN'
    end;
$$;

-- What each year would close, and whether it already has.
--
-- The balances are computed from journal lines dated inside the year rather
-- than from the documents' fiscal_year_id, because a period lock is about
-- dates and an entry's date is what the lock and the income statement both
-- read.
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
       -- Debits are positive, so a profitable year sums negative. Flipped
       -- here so the column reads the way anybody asking would expect.
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
         limit 1)                                                     as closed_by_document_id
  from fiscal_year fy;
