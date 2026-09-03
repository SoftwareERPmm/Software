-- Reference numbers become Type + Date + sequence.
--
--   R20260901001   cash received      CR20260901001  customer received
--   P20260901001   cash payment       CP20260901001  supplier payment
--   DS20260901001  direct sales       DP20260901001  direct purchase
--   STR20260901001 stock received     SI20260901001  stock issued
--
-- Replacing PI-2627-000001, where the middle segment was the fiscal year and
-- the count ran for that whole year. The count now restarts each day, which
-- is what makes the date in the number meaningful rather than decorative.
--
-- Two consequences worth stating, because numbering has broken this system
-- before (see 0025):
--
--   * Documents already numbered keep their numbers. They are immutable and
--     nothing here rewrites them, so a database carries both shapes — the old
--     ones ending, the new ones beginning. Uniqueness is unaffected: the
--     shapes cannot collide.
--   * The series is now keyed by day rather than by fiscal year, so the
--     row-lock that makes numbering gapless locks one day's counter. Two
--     documents of the same type on the same day still serialise; two on
--     different days no longer contend at all.
--
-- SI is deliberately Stock Issued here, not Sales Invoice. A sales invoice is
-- Direct Sales, DS. That reassignment is the customer's own scheme.

-- ---------------------------------------------------------------- direction --

-- A cash voucher can be money in or money out, and nothing recorded which.
-- The direction was only ever implied by the sign of the cash line, which is
-- why no report could tell a receipt from a payment without re-deriving it
-- from the journal. R and P need it, so it is stored.
alter table document add column if not exists voucher_direction text
    check (voucher_direction in ('IN', 'OUT'));

comment on column document.voucher_direction is
    'IN or OUT for cash and bank vouchers, set from the sign of the money '
    'line at posting. Null for every other document type.';

-- ------------------------------------------------------------------ series --

-- The day this counter belongs to. Null on every pre-existing row, which is
-- what keeps the old fiscal-year series intact and inert.
alter table number_series add column if not exists series_date date;

-- One counter per company, series key and day. Partial, so the old rows —
-- which have no series_date — are untouched by it and keep their own
-- constraint.
create unique index if not exists number_series_day_uq
    on number_series (company_id, document_type, series_date)
 where series_date is not null;

-- ----------------------------------------------------------------- prefixes --

create or replace function fn_document_prefix(p_type text, p_direction text)
returns text language sql immutable as $$
    select case
        -- Money in and out share a document type, so the direction decides.
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

        -- Not in the customer's table; same shape so nothing looks foreign.
        when p_type = 'PURCHASE_ORDER'      then 'PO'
        when p_type = 'SALES_ORDER'         then 'SO'
        when p_type = 'CASH_TRANSFER'       then 'CT'
        when p_type = 'OPENING_BALANCE'     then 'OB'
        when p_type = 'CONSIGNMENT_RECEIPT' then 'CNR'

        -- Journal entries are not documents and are numbered separately; JE
        -- keeps them distinct from the J of a journal voucher, which would
        -- otherwise share a prefix and hand out the same number twice.
        when p_type = 'JOURNAL'             then 'JE'
        else left(p_type, 3)
    end;
$$;

-- ------------------------------------------------------------------ next no --

-- The signature changes: a date rather than a fiscal year, plus the
-- direction. Dropped rather than replaced because the argument types differ,
-- and every caller is updated in the same release.
drop function if exists fn_next_document_no(uuid, text, uuid);

create or replace function fn_next_document_no(
    p_company uuid, p_type text, p_date date, p_direction text default null
) returns text language plpgsql as $$
declare
    s       number_series;
    v_pfx   text := fn_document_prefix(p_type, p_direction);
    -- Direction is part of the series key, or cash in and cash out would
    -- share one counter and R and P would interleave.
    v_key   text := p_type || coalesce(':' || p_direction, '');
begin
    select * into s from number_series
     where company_id = p_company
       and document_type = v_key
       and series_date = p_date
     for update;

    if not found then
        insert into number_series (company_id, document_type, series_date,
                                   prefix, padding, next_value)
        values (p_company, v_key, p_date, v_pfx, 3, 1)
        returning * into s;
    end if;

    update number_series set next_value = s.next_value + 1 where id = s.id;

    -- lpad pads but never truncates, so a day that runs past 999 documents
    -- simply widens to four digits rather than colliding.
    return v_pfx || to_char(p_date, 'YYYYMMDD')
           || lpad(s.next_value::text, s.padding, '0');
end;
$$;

comment on function fn_next_document_no is
    'The next reference for this type on this date: prefix, YYYYMMDD, and a '
    'sequence that restarts daily. Takes a row lock on the day''s counter, so '
    'numbers are gapless and two documents cannot take the same one.';

-- ------------------------------------------------------------------ peek ----

drop function if exists fn_peek_document_no(uuid, text, uuid);

create or replace function fn_peek_document_no(
    p_company uuid, p_type text, p_date date, p_direction text default null
) returns text language plpgsql stable as $$
declare
    s     number_series;
    v_key text := p_type || coalesce(':' || p_direction, '');
begin
    select * into s from number_series
     where company_id = p_company
       and document_type = v_key
       and series_date = p_date;

    -- Nothing of this type posted on this date yet, so the next one starts
    -- the day's count.
    return fn_document_prefix(p_type, p_direction) || to_char(p_date, 'YYYYMMDD')
           || lpad(coalesce(s.next_value, 1)::text, coalesce(s.padding, 3), '0');
end;
$$;

comment on function fn_peek_document_no is
    'The number the next document of this type would receive on this date. '
    'Read-only: it takes no lock and reserves nothing, so whoever posts '
    'first gets it.';
