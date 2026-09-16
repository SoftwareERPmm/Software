-- 0068_a_reason_that_was_never_recorded_says_so.sql
-- The reconciliation screen reads the reason, and says when there is none.
--
-- 0067 added negative_stock_reason and bound every confirmation written from
-- then on to carry one. What it could not do is give one to the deliveries
-- confirmed before the column existed, and inventing something for them would
-- have put words in somebody's mouth.
--
-- So the view carries the reason as it is, and a flag for the case that needs
-- saying out loud: confirmed, and no reason recorded, because none was ever
-- asked for. The screen prints "Reason not recorded — legacy" rather than an
-- empty cell, which would read as an answer of "none" — as though somebody
-- had been asked and declined. Nobody was asked.
--
-- Worth keeping visible rather than tidying away. Every one of these is a
-- confirmation whose grounds are unknown, and a company that still has them
-- cannot validate 0067's constraint. Making them legible is what eventually
-- makes them go away.

-- Dropped and recreated rather than replaced: create or replace cannot add a
-- column in the middle of a view's list, and the two new ones belong beside
-- the confirmation they describe rather than tacked on at the end.
drop view if exists v_negative_stock;

create view v_negative_stock as
select
    ns.company_id,
    ns.id,
    ns.item_id,
    i.code   as item_code,
    i.name   as item_name,
    ns.location_id,
    l.code   as location_code,
    l.name   as location_name,
    ns.document_id,
    d.doc_no as document_no,
    d.doc_type,
    to_char(d.doc_date, 'YYYY-MM-DD') as doc_date,
    ns.qty,
    coalesce(s.settled, 0)              as settled,
    ns.qty - coalesce(s.settled, 0)     as outstanding,
    ns.provisional_unit_cost,
    (ns.qty - coalesce(s.settled, 0)) * ns.provisional_unit_cost as outstanding_value,
    d.negative_stock_confirmed_at       as confirmed_at,
    d.negative_stock_confirmed_by       as confirmed_by,
    d.negative_stock_reason             as confirmed_reason,
    -- Confirmed before anybody was asked why. Not the same as a blank reason,
    -- and not to be shown as one.
    d.negative_stock_reason_legacy      as reason_is_legacy,
    ns.created_at
  from negative_stock ns
  join item     i on i.id = ns.item_id
  join location l on l.id = ns.location_id
  join document d on d.id = ns.document_id
  left join (
        select negative_stock_id, sum(qty) as settled
          from negative_stock_settlement
         group by negative_stock_id
  ) s on s.negative_stock_id = ns.id
 where ns.qty - coalesce(s.settled, 0) > 0.0001;

comment on view v_negative_stock is
    'Stock that went out before anything recorded it arriving, still awaiting '
    'a receipt or an adjustment. confirmed_reason is why somebody said the '
    'goods were there; reason_is_legacy marks a confirmation made before the '
    'reason was asked for, which a screen shows as "Reason not recorded -- '
    'legacy" rather than as an empty answer.';
