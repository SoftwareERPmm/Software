-- The tie-break that wasn't.
--
-- getFormData asks for an item's next cost like this:
--
--     coalesce((select unit_cost from v_stock_lot_open
--                where company_id = ... and item_id = i.id
--                order by received_date, created_at limit 1), 0)
--
-- v_stock_lot_open has never had a created_at. Postgres did not complain,
-- because the subquery sits inside a select over `item`, and `item` does have
-- one — so the name resolved outward and every lot was ordered by the
-- *item's* creation time, which is the same value for all of them. The
-- tie-break silently did nothing, and two lots received on one day were
-- returned in whatever order the plan happened to produce.
--
-- Harmless most days and wrong on exactly the day it matters: same-day
-- receipts at different prices are when "which cost comes next" has an
-- answer worth getting right. Every other lot ordering in the codebase reads
-- (received_date, created_at) — the FIFO draw included — so the view should
-- offer what they all ask for, and the inner scope then wins over the outer
-- one without the caller changing at all.
--
-- 0057 rebuilt this view and did not add the column; it is added here rather
-- than there because 0057 is applied.

drop view if exists v_stock_lot_open;

create view v_stock_lot_open as
select
    l.id as lot_id, l.company_id, l.item_id, l.location_id,
    l.received_date,
    l.created_at,
    l.unit_cost + coalesce(a.delta, 0) as unit_cost,
    l.unit_cost                        as original_unit_cost,
    coalesce(a.delta, 0)               as cost_adjustment,
    l.qty_received,
    l.qty_received - coalesce(sum(c.qty), 0) as qty_remaining
  from stock_lot l
  left join stock_lot_consumption c on c.lot_id = l.id
  left join lateral (
        select sum(adj.delta_unit_cost) as delta
          from stock_lot_adjustment adj
         where adj.lot_id = l.id
  ) a on true
 group by l.id, l.company_id, l.item_id, l.location_id,
          l.received_date, l.created_at, l.unit_cost, l.qty_received, a.delta
having l.qty_received - coalesce(sum(c.qty), 0) > 0.0001;

comment on view v_stock_lot_open is
    'Lots with stock still in them, at what that stock now costs. A lot whose '
    'bill later disagreed with its receipt carries the corrected figure here, '
    'so goods issued after the correction are relieved at what was actually '
    'paid rather than at what was first estimated. Ordered on '
    '(received_date, created_at) by every caller, so both are exposed.';
