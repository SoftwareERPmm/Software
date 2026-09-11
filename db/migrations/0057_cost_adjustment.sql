-- The bill disagrees with the receipt, and some of the goods have already gone.
--
-- Until now the whole difference went to Purchase Price Variance. Twenty boxes
-- received at 100 and billed at 130 expensed the 600 and left the boxes on the
-- books at 100 each — even when all twenty were still on the shelf, unsold,
-- and demonstrably worth what was paid for them. That is defensible under a
-- standard-costing system, where a variance account is the whole point. It is
-- not what an actual-cost FIFO system should do, and it is not what the
-- systems this one is measured against do either: Odoo splits the difference
-- between the goods still in stock and the goods already issued, and Business
-- Central traces the corrected cost forward into the sales that consumed it.
--
-- So the difference is split by where the goods actually are:
--
--     20 still held        →  600 onto the stock, nothing expensed
--     8 issued, 12 held    →  360 onto the stock, 240 to cost of sales
--     20 issued            →  nothing to add to, 600 to cost of sales
--
-- Two things this deliberately does not do. It does not receive the goods
-- again: the quantity added is zero, the receipt keeps its history, and
-- nothing about what physically arrived is restated. And it does not reach
-- back into the sales that already happened — the issued share lands in cost
-- of sales at the date of the correction, in the period the correction
-- belongs to, rather than reopening documents in a closed month.

-- ---------------------------------------------------------------------------
-- What a lot cost, corrected after the fact.

create table if not exists stock_lot_adjustment (
    id              uuid primary key default gen_random_uuid(),
    company_id      uuid not null references company(id),
    lot_id          uuid not null references stock_lot(id),

    -- The bill that revalued it, or the corrected version of that bill.
    document_id     uuid references document(id),

    -- Added to this lot's unit cost from this moment forward. Signed: a bill
    -- for less than the receipt estimated takes value back out.
    --
    -- Forward only, and that is the whole mechanism. Units already issued were
    -- relieved at the old cost and their share of the difference has gone to
    -- cost of sales; units still held carry the new one. Applying it
    -- retrospectively would double-count the issued share and restate closed
    -- periods at the same time.
    delta_unit_cost numeric(18,4) not null,

    -- How the split was made. Derivable today and not tomorrow: consumption
    -- after this row would make the same sum come out differently, and this is
    -- the record of what was actually posted.
    qty_remaining   numeric(18,4) not null check (qty_remaining >= 0),
    qty_issued      numeric(18,4) not null check (qty_issued    >= 0),

    reason          text,
    created_at      timestamptz not null default now(),

    -- A revaluation that touches neither held nor issued goods is not a
    -- revaluation.
    constraint stock_lot_adjustment_touches_something
        check (qty_remaining > 0 or qty_issued > 0)
);

create index if not exists stock_lot_adjustment_lot_idx
    on stock_lot_adjustment (lot_id);
create index if not exists stock_lot_adjustment_doc_idx
    on stock_lot_adjustment (document_id) where document_id is not null;

comment on table stock_lot_adjustment is
    'A correction to what a receipt lot cost, made after the lot was created. '
    'Append-only beside stock_lot, which is immutable: the original cost is '
    'what was known at the time and stays readable, and this is what has been '
    'learned since.';

-- Append-only, exactly like the lots it corrects.
create or replace function fn_stock_lot_adjustment_immutable() returns trigger
language plpgsql as $$
begin
    raise exception
        'Cost adjustments are append-only. Post another adjustment instead.';
end;
$$;

drop trigger if exists trg_stock_lot_adjustment_immutable on stock_lot_adjustment;
create trigger trg_stock_lot_adjustment_immutable
    before update or delete on stock_lot_adjustment
    for each row execute function fn_stock_lot_adjustment_immutable();

-- ---------------------------------------------------------------------------
-- A movement that carries value and no quantity.
--
-- The inventory account has to move when stock is revalued, and
-- v_check_inventory_reconciliation ties that account to the sum of
-- stock_movement.total_cost. So the revaluation has to be a movement, or the
-- invariant every test suite checks would break on the first correction.
--
-- v_stock_on_hand was already written for this — it keeps a row where the
-- quantity nets to zero but the value does not. Only the check constraint
-- stood in the way, and it was guarding against an empty movement rather than
-- a valuation one.

alter table stock_movement drop constraint if exists stock_movement_qty_check;
alter table stock_movement add constraint stock_movement_qty_check
    check (qty <> 0 or total_cost <> 0);

comment on constraint stock_movement_qty_check on stock_movement is
    'A movement moves goods, or value, or both — never neither. Value without '
    'quantity is a revaluation: the goods are already here and are worth '
    'something different from what was first thought.';

-- ---------------------------------------------------------------------------
-- What a lot costs now.
--
-- Rebuilt rather than added beside, so there is one answer to the question and
-- every existing caller gets the corrected one. `unit_cost` keeps its name and
-- becomes the cost as it stands; what the receipt originally said is still
-- there under its own name for anyone reconciling back to the document.

drop view if exists v_stock_lot_open;

create view v_stock_lot_open as
select
    l.id as lot_id, l.company_id, l.item_id, l.location_id,
    l.received_date,
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
          l.received_date, l.unit_cost, l.qty_received, a.delta
having l.qty_received - coalesce(sum(c.qty), 0) > 0.0001;

comment on view v_stock_lot_open is
    'Lots with stock still in them, at what that stock now costs. A lot whose '
    'bill later disagreed with its receipt carries the corrected figure here, '
    'so goods issued after the correction are relieved at what was actually '
    'paid rather than at what was first estimated.';
