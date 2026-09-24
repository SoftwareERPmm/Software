-- Goods cannot move on a day that has not happened.
--
-- Nothing anywhere compared a posting date to today. The only gate was
-- fn_journal_entry_period: a fiscal period must exist and be OPEN. Since the
-- calendar creates a whole year of periods up front and opens them all, any
-- date inside the fiscal year posted without complaint — a delivery dated
-- next March was as acceptable as one dated this morning.
--
-- For a journal voucher that is correct and stays allowed. Dating September's
-- depreciation the 30th while entering it on the 2nd is ordinary practice,
-- and the pilot has exactly that document. A voucher dated ahead is a
-- presentation question, and the form now says so rather than refusing.
--
-- A stock movement is not a presentation question. There is no sense in which
-- goods physically moved on a day that has not arrived, and the FIFO lot
-- selector has no date filter — it takes every lot for the item and location
-- ordered by received_date, with no condition that the lot was received on or
-- before the issue date. So a goods receipt dated the 30th creates a lot that
-- a delivery dated the 24th will happily consume: stock sold before it
-- arrived, with the cost layers drawn out of order. That is corrupted data,
-- not an odd-looking report.
--
-- In the database rather than in lib/posting.ts because posting.ts has ten
-- separate "insert into stock_movement" sites, and a rule written ten times
-- is a rule that will be nine times next year. Same reasoning as
-- fn_journal_entry_period, fn_document_immutable and
-- fn_journal_line_account_guard, which all live here for the same reason.
--
-- Compared against Yangon's date, not the server's. The database runs with
-- TimeZone = GMT, and Myanmar is UTC+06:30 — so between midnight and 06:30
-- local, current_date is still yesterday, and a warehouse receiving goods at
-- 7am would have been told its own date was in the future. Naming the zone
-- fixes that exactly, where a day of slack would only have hidden it and
-- would have let a genuine day-ahead entry through.

create or replace function fn_stock_movement_not_future() returns trigger
language plpgsql as $$
declare
    today_local date := (now() at time zone 'Asia/Yangon')::date;
begin
    if new.movement_date > today_local then
        raise exception
            'Stock cannot move on %, which is after today (%). Goods that have '
            'not arrived cannot be received, and goods that have not left '
            'cannot be delivered.',
            to_char(new.movement_date, 'DD Mon YYYY'),
            to_char(today_local, 'DD Mon YYYY');
    end if;
    return new;
end;
$$;

comment on function fn_stock_movement_not_future is
    'Refuses a stock movement dated after today in Myanmar. Journal, cash and '
    'bank vouchers are deliberately not covered — a voucher dated at month end '
    'is normal accounting.';

drop trigger if exists trg_stock_movement_not_future on stock_movement;
create trigger trg_stock_movement_not_future
    before insert on stock_movement
    for each row execute function fn_stock_movement_not_future();

-- History is left alone: the trigger is BEFORE INSERT, so rows already
-- recorded stand whatever their date. This says whether there are any, so
-- applying it to a database with future-dated stock is not silent.
do $$
declare
    n int;
begin
    select count(*) into n from stock_movement
     where movement_date > (now() at time zone 'Asia/Yangon')::date;
    if n > 0 then
        raise notice
            '% stock movement(s) are already dated after today. They are left '
            'as they are; only new ones are refused.', n;
    end if;
end $$;
