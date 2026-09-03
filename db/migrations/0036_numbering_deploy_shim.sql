-- Put back the old numbering functions, for the length of a deploy.
--
-- 0035 replaced fn_next_document_no and fn_peek_document_no with versions
-- taking a date instead of a fiscal year, and dropped the old signatures.
-- That makes it the first migration here that is *not* backward compatible:
-- the ordering rule in CLAUDE.md — migrate first, then push — is safe only
-- because older code ignores a new column, and code already running cannot
-- ignore a function that has been deleted out from under it.
--
-- Applied to a live database ahead of its code, 0035 would therefore have
-- broken every posting until the new build finished. Small window, real
-- outage, and precisely the failure the ordering rule exists to prevent.
--
-- So the old signatures come back, behaving as they did, producing the old
-- PI-2627-000001 shape from the old per-fiscal-year series. Nothing calls
-- them after the deploy completes; they exist so that during it, whichever
-- version of the code is running finds the function it expects.
--
-- Safe to drop in a later migration once no deployment is serving pre-0035
-- code. Left in place deliberately rather than removed in the same release —
-- removing it is the thing that has to wait, not the thing that has to hurry.

create or replace function fn_next_document_no(
    p_company uuid, p_type text, p_fiscal_year uuid
) returns text language plpgsql as $$
declare
    s      number_series;
    v_pfx  text;
begin
    select * into s from number_series
     where company_id = p_company
       and document_type = p_type
       and fiscal_year_id is not distinct from p_fiscal_year
       and series_date is null
     for update;

    if not found then
        v_pfx := case p_type
            when 'PURCHASE_ORDER'    then 'PO-'
            when 'GOODS_RECEIPT'     then 'GR-'
            when 'PURCHASE_INVOICE'  then 'PI-'
            when 'PURCHASE_RETURN'   then 'PR-'
            when 'SUPPLIER_PAYMENT'  then 'PAY-'
            when 'SALES_ORDER'       then 'SO-'
            when 'DELIVERY'          then 'DO-'
            when 'SALES_INVOICE'     then 'SI-'
            when 'SALES_RETURN'      then 'SR-'
            when 'CUSTOMER_RECEIPT'  then 'RC-'
            when 'STOCK_ADJUSTMENT'  then 'ADJ-'
            when 'STOCK_TRANSFER'    then 'TRF-'
            when 'OPENING_BALANCE'   then 'OB-'
            when 'CASH_VOUCHER'      then 'CV-'
            when 'BANK_VOUCHER'      then 'BV-'
            when 'JOURNAL_VOUCHER'   then 'JV-'
            when 'CASH_TRANSFER'     then 'CT-'
            when 'JOURNAL'           then 'JE-'
            else left(p_type, 3) || '-'
        end;
        insert into number_series (company_id, document_type, fiscal_year_id,
                                   prefix, padding, next_value)
        values (p_company, p_type, p_fiscal_year, v_pfx, 6, 1)
        returning * into s;
    end if;

    update number_series set next_value = s.next_value + 1 where id = s.id;

    return s.prefix || fn_document_no_year(p_fiscal_year)
           || lpad(s.next_value::text, s.padding, '0');
end;
$$;

comment on function fn_next_document_no(uuid, text, uuid) is
    'Superseded by the (uuid, text, date, text) version in 0035. Kept only so '
    'that code deployed before that migration keeps working while a release '
    'is in flight. Safe to drop once nothing serves pre-0035 code.';

create or replace function fn_peek_document_no(
    p_company uuid, p_type text, p_fiscal_year uuid
) returns text language plpgsql stable as $$
declare
    s number_series;
begin
    select * into s from number_series
     where company_id = p_company
       and document_type = p_type
       and fiscal_year_id is not distinct from p_fiscal_year
       and series_date is null;

    if not found then
        return null;
    end if;

    return s.prefix || fn_document_no_year(p_fiscal_year)
           || lpad(s.next_value::text, s.padding, '0');
end;
$$;

comment on function fn_peek_document_no(uuid, text, uuid) is
    'Superseded by the (uuid, text, date, text) version in 0035. Kept for the '
    'duration of a deploy, same as fn_next_document_no(uuid, text, uuid).';
