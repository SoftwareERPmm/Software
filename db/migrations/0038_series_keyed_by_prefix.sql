-- Key a number series by the prefix it prints, not by the type behind it.
--
-- 0035 keyed each counter on the document type plus the direction:
-- 'CASH_VOUCHER:IN', 'CASH_VOUCHER:OUT'. That is one key per *caller*, and it
-- is the wrong thing to count by, because two different keys can print the
-- same prefix:
--
--   fn_next_document_no(co, 'CASH_VOUCHER', d, 'IN')  -> key CASH_VOUCHER:IN  -> R2026...001
--   fn_next_document_no(co, 'CASH_VOUCHER', d, null)  -> key CASH_VOUCHER     -> R2026...001
--
-- Two counters, one number space, and the second document to be written takes
-- a number the first already has. Found by the void tests: voiding a cash
-- receipt called the function without a direction, and the reversal collided
-- with the receipt it was reversing.
--
-- Keying on the prefix makes the collision unrepresentable rather than merely
-- avoided: anything printing R counts on the R counter, whoever asked and
-- however they asked for it. The uniqueness the database enforces is on the
-- number, so the number is what the counter must belong to.

create or replace function fn_next_document_no(
    p_company uuid, p_type text, p_date date, p_direction text default null
) returns text language plpgsql as $$
declare
    s     number_series;
    v_pfx text := fn_document_prefix(p_type, p_direction);
begin
    select * into s from number_series
     where company_id = p_company
       and document_type = v_pfx
       and series_date = p_date
     for update;

    if not found then
        insert into number_series (company_id, document_type, series_date,
                                   prefix, padding, next_value)
        values (p_company, v_pfx, p_date, v_pfx, 3, 1)
        returning * into s;
    end if;

    update number_series set next_value = s.next_value + 1 where id = s.id;

    return v_pfx || to_char(p_date, 'YYYYMMDD')
           || lpad(s.next_value::text, s.padding, '0');
end;
$$;

create or replace function fn_peek_document_no(
    p_company uuid, p_type text, p_date date, p_direction text default null
) returns text language plpgsql stable as $$
declare
    s     number_series;
    v_pfx text := fn_document_prefix(p_type, p_direction);
begin
    select * into s from number_series
     where company_id = p_company
       and document_type = v_pfx
       and series_date = p_date;

    return v_pfx || to_char(p_date, 'YYYYMMDD')
           || lpad(coalesce(s.next_value, 1)::text, coalesce(s.padding, 3), '0');
end;
$$;

-- Rows written under the old key still exist and would keep their own count.
-- Merged onto the prefix key, taking the highest count of the two, so nothing
-- that has already been issued can be issued again.
do $$
declare r record;
begin
    for r in
        select company_id, series_date,
               fn_document_prefix(split_part(document_type, ':', 1),
                                  nullif(split_part(document_type, ':', 2), '')) as pfx,
               max(next_value) as next_value
          from number_series
         where series_date is not null and document_type like '%\_%' escape '\'
         group by 1, 2, 3
    loop
        insert into number_series (company_id, document_type, series_date,
                                   prefix, padding, next_value)
        values (r.company_id, r.pfx, r.series_date, r.pfx, 3, r.next_value)
        on conflict (company_id, document_type, series_date)
          where series_date is not null
          do update set next_value = greatest(number_series.next_value, excluded.next_value);
    end loop;

    delete from number_series
     where series_date is not null and document_type like '%\_%' escape '\';
end;
$$;
