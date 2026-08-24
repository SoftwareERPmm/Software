-- 0026_peek_document_no.sql
-- One definition of what a document number looks like.
--
-- 0025 put the fiscal year into the number, and immediately exposed a second
-- copy of the format: the sales voucher previews the number the next invoice
-- will get, and did it by rebuilding the string in application SQL -
-- `coalesce(prefix, 'SI-') || lpad(next_value, padding, '0')`. That copy did
-- not know about the year, so the voucher would have promised SI-000001 while
-- posting issued SI-2627-000001.
--
-- Two hand-written copies of a format is how the format drifts, and this one
-- drifted within a single migration of being changed. So the year segment
-- becomes a function both callers share, and the preview becomes a function
-- of its own rather than a query the application assembles.
--
-- fn_peek_document_no is deliberately read-only: no lock, no increment, and
-- it creates no series row. The real number is still taken under a row lock
-- at posting time, so a preview can be overtaken by whoever posts first -
-- which is why it is a peek and not a reservation.

create or replace function fn_document_no_year(p_fiscal_year uuid)
returns text language plpgsql stable as $$
declare
    fy fiscal_year;
begin
    if p_fiscal_year is null then
        return '';
    end if;

    select * into fy from fiscal_year where id = p_fiscal_year;
    if not found then
        return '';
    end if;

    -- A year inside one calendar year reads 26; one that straddles two reads
    -- 2627, which is how a Myanmar April-to-March year is written down.
    return case
        when extract(year from fy.start_date) = extract(year from fy.end_date)
            then to_char(fy.start_date, 'YY')
        else to_char(fy.start_date, 'YY') || to_char(fy.end_date, 'YY')
    end || '-';
end;
$$;

create or replace function fn_next_document_no(
    p_company uuid, p_type text, p_fiscal_year uuid
) returns text language plpgsql as $$
declare
    s     number_series;
    v_pfx text;
begin
    select * into s from number_series
     where company_id = p_company
       and document_type = p_type
       and fiscal_year_id is not distinct from p_fiscal_year
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

        insert into number_series (company_id, document_type, fiscal_year_id, prefix, next_value)
        values (p_company, p_type, p_fiscal_year, v_pfx, 1)
        returning * into s;
    end if;

    update number_series set next_value = next_value + 1 where id = s.id;

    return s.prefix || fn_document_no_year(p_fiscal_year)
           || lpad(s.next_value::text, s.padding, '0');
end;
$$;

-- What the next number would be, without taking it.
create or replace function fn_peek_document_no(
    p_company uuid, p_type text, p_fiscal_year uuid
) returns text language plpgsql stable as $$
declare
    s number_series;
begin
    select * into s from number_series
     where company_id = p_company
       and document_type = p_type
       and fiscal_year_id is not distinct from p_fiscal_year;

    -- No series yet means nothing of this type has ever been posted in this
    -- year, so the next one starts the count.
    if not found then
        return null;
    end if;

    return s.prefix || fn_document_no_year(p_fiscal_year)
           || lpad(s.next_value::text, s.padding, '0');
end;
$$;

comment on function fn_peek_document_no is
    'The number the next document of this type would receive. Read-only: it '
    'takes no lock and reserves nothing, so whoever posts first gets it.';
