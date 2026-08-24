-- 0025_fiscal_year_in_numbers.sql
-- Put the fiscal year into document numbers, so a new year can be posted at all.
--
-- Numbering is per company, per document type, per fiscal year - that is the
-- documented rule (docs/01-document-flow.md), and 0009 auto-creates a series
-- for a new year precisely so nobody has to hand-insert one. A new year
-- therefore starts again at 1 and issues PI-000001.
--
-- But document is UNIQUE (company_id, doc_type, doc_no), with no year in it,
-- and journal_entry is UNIQUE (company_id, entry_no). So the first purchase
-- invoice of the second year collides with the first invoice of the first
-- year and is rejected:
--
--   duplicate key value violates unique constraint
--   "document_company_id_doc_type_doc_no_key"
--
-- The two halves of the design contradict each other: one restarts the count
-- every year, the other requires the count to be unique forever. Nothing was
-- wrong on either side alone, which is why it went unnoticed - a company can
-- only hit it by surviving into its second fiscal year. Every journal entry
-- is numbered the same way, so the failure is not confined to documents;
-- once the year turns, nothing posts.
--
-- Found while trying to force a concurrency race across two fiscal years.
--
-- The number now carries the year it belongs to, which is what makes the
-- restart safe:
--
--   FY 2026-27    PI-2627-000001
--   FY 2027-28    PI-2728-000001
--
-- A fiscal year inside one calendar year gets the single year - Jan-Dec 2026
-- reads PI-26-000001. The uniqueness constraints are left exactly as they
-- are: they were never the wrong rule, they just had nothing to hold on to.
--
-- Applied while pilot and main hold no documents at all, so nothing carries
-- the old format. That will never be true again.

create or replace function fn_next_document_no(
    p_company uuid, p_type text, p_fiscal_year uuid
) returns text language plpgsql as $$
declare
    s      number_series;
    v_pfx  text;
    v_year text := '';
    fy     fiscal_year;
begin
    -- The year segment, derived from the dates rather than fiscal_year.code,
    -- so it does not depend on how someone chose to name the year.
    if p_fiscal_year is not null then
        select * into fy from fiscal_year where id = p_fiscal_year;
        if found then
            v_year := case
                when extract(year from fy.start_date) = extract(year from fy.end_date)
                    then to_char(fy.start_date, 'YY')
                else to_char(fy.start_date, 'YY') || to_char(fy.end_date, 'YY')
            end || '-';
        end if;
    end if;

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

    return s.prefix || v_year || lpad(s.next_value::text, s.padding, '0');
end;
$$;

comment on function fn_next_document_no is
    'Gapless numbering, per company, per document type, per fiscal year. The '
    'year is part of the number because the count restarts with it, and '
    'document numbers must stay unique for the life of the company.';
