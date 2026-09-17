-- A handset is one of a kind
--
-- Twelve cartons of biscuits are twelve of the same thing: the stock ledger
-- counts them and nobody asks which. Twelve handsets are twelve different
-- things, and the difference matters after the sale rather than during it —
-- a warranty claim, a return, a police enquiry, all of which begin with an
-- IMEI and ask who had it.
--
-- item.serial already exists and is not this. It is part of the item's code,
-- a sequence within its category, and every unit of that item shares it.
-- tracks_batch and tracks_expiry exist and have nothing behind them. This
-- adds the third kind of tracking and the tables it needs.
--
-- Per item, not per company. A phone shop sells handsets and also sells
-- cases, and only one of those has an identity worth keeping. A trading
-- company simply never turns it on, and runs the same code.

alter table item
  add column if not exists tracks_serial boolean not null default false;

comment on column item.tracks_serial is
    'Each unit of this item has an identity of its own — an IMEI, a chassis '
    'number, a machine serial. Receiving one means naming every unit; issuing '
    'one means saying which units left. Not to be confused with item.serial, '
    'which is part of this item''s code and shared by every unit of it.';

-- ---------------------------------------------------------------------------
-- The units themselves.
--
-- Written when the goods arrive and never rewritten: what arrived, arrived.
-- The lot it belongs to carries the cost, so a serial is not a second opinion
-- about valuation — it is an identity attached to one unit of an existing
-- FIFO layer, which is what keeps costing unchanged by any of this.

create table if not exists stock_serial (
    id                uuid primary key default gen_random_uuid(),
    company_id        uuid not null references company(id),
    item_id           uuid not null references item(id),
    serial_no         text not null,
    -- Which layer this unit is part of, and therefore what it cost.
    stock_lot_id      uuid not null references stock_lot(id),
    -- The movement that brought it in, so the document is always reachable.
    stock_movement_id uuid not null references stock_movement(id),
    created_at        timestamptz not null default now()
);

-- The same IMEI cannot arrive twice while it is still here. Enforced on the
-- company and the number alone rather than per item: two items sharing one
-- IMEI is a keying error, not a legitimate arrangement.
create unique index if not exists stock_serial_unique_idx
    on stock_serial (company_id, serial_no);

create index if not exists stock_serial_item_idx
    on stock_serial (company_id, item_id);

-- ---------------------------------------------------------------------------
-- And where they went.
--
-- Append-only, like every other record of something leaving. A unit is in
-- stock when it has arrived and has no issue standing against it — derived,
-- never stored, so there is no status field to disagree with the movements.
--
-- "Standing" is doing real work there. Voiding a delivery does not delete its
-- issue row; the row stays and stops counting, because the document that made
-- it is reversed. The same rule 0070 applies to a payment's allocations and
-- 0073 to an advance application: a record counts while the document that
-- wrote it stands.

create table if not exists stock_serial_issue (
    id                uuid primary key default gen_random_uuid(),
    company_id        uuid not null references company(id),
    serial_id         uuid not null references stock_serial(id),
    stock_movement_id uuid not null references stock_movement(id),
    created_at        timestamptz not null default now()
);

create index if not exists stock_serial_issue_serial_idx
    on stock_serial_issue (serial_id);

-- ---------------------------------------------------------------------------
-- What is on the shelf, by identity.

create or replace view v_stock_serial_available as
select s.company_id,
       s.id as serial_id,
       s.serial_no,
       s.item_id,
       i.code as item_code,
       i.name as item_name,
       l.location_id,
       s.stock_lot_id,
       l.unit_cost,
       d.doc_no as received_on,
       d.id     as received_document_id
  from stock_serial s
  join item i on i.id = s.item_id
  join stock_lot l on l.id = s.stock_lot_id
  join stock_movement sm on sm.id = s.stock_movement_id
  left join document d on d.id = sm.document_id
 where not exists (
       select 1
         from stock_serial_issue si
         join stock_movement osm on osm.id = si.stock_movement_id
         left join document od on od.id = osm.document_id
        where si.serial_id = s.id
          -- An issue on a document that was voided is not an issue. Where the
          -- movement has no document at all, it stands: nothing can undo it.
          and (od.id is null
               or (od.status <> 'REVERSED' and od.reverses_document_id is null))
     );

comment on view v_stock_serial_available is
    'Serial-tracked units currently on the shelf: received, and not issued by '
    'any document that still stands. What a delivery may choose from, and what '
    'a stock count should find.';
