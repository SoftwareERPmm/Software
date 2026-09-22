-- A batch is a layer with a name, and sometimes a date.
--
-- item.tracks_batch and item.tracks_expiry have existed since the beginning
-- with nothing behind them. They are per item, like tracks_serial: a
-- distributor selling milk powder and also selling buckets turns batches on
-- for the milk powder, and the buckets carry on exactly as they did.
--
-- Two switches rather than one. A batch on its own is traceability — which
-- lot do these units belong to, so a recall can name them — and plenty of
-- goods have that without a shelf life: machine parts, packaging, chemicals
-- by lot. Expiry is the extra that perishable goods need, and it only makes
-- sense once there is a batch to attach it to.
--
-- The batch lives on the FIFO layer, because that is what a batch already
-- is here: goods that arrived together, at one cost, on one date. Two
-- receipts of the same batch number are two layers sharing a name, which is
-- correct — they may have cost different amounts. Consumption already
-- records which layer each issue drew from, so tracing a sale back to a
-- batch needs no new link.

alter table stock_lot
  add column if not exists batch_no    text,
  add column if not exists expiry_date date;

comment on column stock_lot.batch_no is
  'The lot number these goods arrived under, for items that track batches. Null on stock received before tracking was turned on, and on items that do not track — those layers issue oldest-first as they always have.';

comment on column stock_lot.expiry_date is
  'When this batch stops being sellable. Null unless the item tracks expiry.';

comment on column item.tracks_batch is
  'Goods of this item arrive in identifiable lots, and every receipt must name one. Per item, never per company.';

comment on column item.tracks_expiry is
  'Batches of this item have a shelf life. Only meaningful with tracks_batch: an expiry date needs a batch to belong to.';

-- Picking a perishable item draws the batch that expires first, so the index
-- that matters is by expiry within item and location.
create index if not exists ix_stock_lot_expiry
    on stock_lot (company_id, item_id, location_id, expiry_date)
 where expiry_date is not null;

create index if not exists ix_stock_lot_batch
    on stock_lot (company_id, item_id, batch_no)
 where batch_no is not null;

-- The open-layer view carries them, since it is what both the picking engine
-- and every stock screen read. Rebuilt from the live definition with two
-- columns added and nothing else touched.
create or replace view v_stock_lot_open as
 SELECT l.id AS lot_id,
    l.company_id,
    l.item_id,
    l.location_id,
    l.received_date,
    l.created_at,
    l.unit_cost + COALESCE(a.delta, 0::numeric) AS unit_cost,
    l.unit_cost AS original_unit_cost,
    COALESCE(a.delta, 0::numeric) AS cost_adjustment,
    l.qty_received,
    l.qty_received - COALESCE(sum(c.qty), 0::numeric) AS qty_remaining,
    -- Appended rather than placed beside received_date: create or replace
    -- view can add columns at the end and nothing else, and dropping this
    -- view would take every view built on it with it.
    l.batch_no,
    l.expiry_date
   FROM stock_lot l
     LEFT JOIN stock_lot_consumption c ON c.lot_id = l.id
     LEFT JOIN LATERAL ( SELECT sum(adj.delta_unit_cost) AS delta
           FROM stock_lot_adjustment adj
          WHERE adj.lot_id = l.id) a ON true
  GROUP BY l.id, l.company_id, l.item_id, l.location_id, l.received_date, l.created_at,
           l.batch_no, l.expiry_date, l.unit_cost, l.qty_received, a.delta
 HAVING (l.qty_received - COALESCE(sum(c.qty), 0::numeric)) > 0.0001;
