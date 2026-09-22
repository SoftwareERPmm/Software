-- A delivery is carried by somebody, in some order.
--
-- Deliveries today know the warehouse they left and the customer they are
-- for, and nothing about the journey between the two. In Myanmar
-- distribution that journey is the operation: a truck is loaded at a branch
-- in the morning, a driver and a salesman take a known list of shops in a
-- known order, and by evening somebody has to answer which stops were made,
-- which were not, and why.
--
-- None of that is accounting. Stock left the warehouse when the delivery
-- posted and the journal entry is already written; a trip records who
-- carried the goods and in what order, and marking a stop delivered is
-- proof of delivery, not a posting. That is why nothing here touches
-- document, journal_entry or stock_lot, and why the trip tables carry no
-- amounts — a trip that could restate a figure would be a second, quieter
-- way to change the ledger.
--
-- Van selling, where stock rides on the truck unsold and the salesman bills
-- from it, is the next step and needs the van to be a stock location. The
-- schema here is deliberately the half that does not depend on that
-- decision: a trip groups deliveries that already exist, so it is useful on
-- its own and is not thrown away when the van becomes a warehouse.

-- ------------------------------------------------------------- the fleet ---

-- The truck. Plate is the identity everyone on a loading bay actually uses;
-- code is the short handle for a screen. Capacity is a note rather than a
-- number because a real load check needs weight and volume per item, which
-- the item master does not carry — a number here would look like a
-- constraint and enforce nothing.
create table if not exists vehicle (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references company(id) on delete cascade,
  code           text not null,
  plate_no       text not null,
  name           text,
  capacity_note  text,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  unique (company_id, code)
);

-- The driver. A separate table rather than a flag on salesman: on a Myanmar
-- route the driver and the salesman are routinely two people on one truck,
-- and collapsing them loses the ability to say which of them was there.
--
-- Standalone for the same reason salesman is standalone — there is no
-- Employee record to hang it off yet. When payroll lands this becomes a
-- link to it rather than a second list of the same people.
create table if not exists driver (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references company(id) on delete cascade,
  code         text not null,
  name         text not null,
  name_my      text,
  phone        text,
  licence_no   text,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (company_id, code)
);

-- -------------------------------------------------------------- the trip ---

-- Status is a journey, not a document lifecycle: PLANNED while the list is
-- being built, DISPATCHED once the truck has gone, CLOSED when it is back
-- and every stop has an answer. CANCELLED is for a trip called off before
-- it left — a trip that went out and failed is CLOSED with failed stops,
-- which is a different and truer thing to record.
create table if not exists delivery_trip (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references company(id) on delete cascade,
  trip_no       text not null,
  trip_date     date not null,
  -- Where it leaves from. The branch, not the warehouse: a trip is a branch
  -- operation and may draw on more than one store within it.
  location_id   uuid references location(id),
  vehicle_id    uuid references vehicle(id),
  driver_id     uuid references driver(id),
  salesman_id   uuid references salesman(id),
  status        text not null default 'PLANNED'
                check (status in ('PLANNED','DISPATCHED','CLOSED','CANCELLED')),
  departed_at   timestamptz,
  closed_at     timestamptz,
  note          text,
  created_at    timestamptz not null default now(),
  unique (company_id, trip_no)
);

create index if not exists ix_delivery_trip_date
  on delivery_trip (company_id, trip_date desc);

-- One stop: a delivery, its place in the running order, and what happened.
--
-- FAILED is not an error state, it is the common one. A shop is shut, the
-- owner is out, the money is not ready — the goods come back on the truck
-- and the delivery still stands as posted. Recording that is the whole
-- point of the evening; a trip that can only say "delivered" forces
-- somebody to lie or to leave it blank.
create table if not exists delivery_trip_stop (
  id              uuid primary key default gen_random_uuid(),
  trip_id         uuid not null references delivery_trip(id) on delete cascade,
  seq             integer not null,
  document_id     uuid not null references document(id),
  status          text not null default 'PENDING'
                  check (status in ('PENDING','DELIVERED','FAILED')),
  delivered_at    timestamptz,
  failure_reason  text,
  note            text,
  created_at      timestamptz not null default now(),
  -- A delivery appears once on a trip. It may appear on a *later* trip: a
  -- stop that failed today is re-attempted tomorrow, and that second
  -- attempt is a real journey, not a correction of the first.
  unique (trip_id, document_id)
);

-- Deferred, because reordering stops swaps seq values within one
-- transaction and an immediate check fails halfway through the swap.
alter table delivery_trip_stop
  drop constraint if exists delivery_trip_stop_trip_id_seq_key;
alter table delivery_trip_stop
  add constraint delivery_trip_stop_trip_id_seq_key
  unique (trip_id, seq) deferrable initially deferred;

create index if not exists ix_delivery_trip_stop_document
  on delivery_trip_stop (document_id);

-- ------------------------------------------------------------ numbering ---

-- TRP. The else branch returns 'GEN', which is the journal's own prefix, so
-- an unlisted type does not fall through to something harmless — it collides.
-- Restated in full rather than patched because a sql function has no way to
-- add a case to itself.
create or replace function fn_document_prefix(p_type text, p_direction text)
returns text language sql immutable as $$
    select case
        when p_type = 'CASH_VOUCHER' and p_direction = 'OUT' then 'P'
        when p_type = 'CASH_VOUCHER'                         then 'R'
        when p_type = 'BANK_VOUCHER' and p_direction = 'OUT' then 'BP'
        when p_type = 'BANK_VOUCHER'                         then 'BR'

        when p_type = 'CUSTOMER_RECEIPT'    then 'CR'
        when p_type = 'SUPPLIER_PAYMENT'    then 'CP'
        when p_type = 'JOURNAL_VOUCHER'     then 'J'
        when p_type = 'SALES_INVOICE'       then 'DS'
        when p_type = 'SALES_RETURN'        then 'SR'
        when p_type = 'PURCHASE_INVOICE'    then 'DP'
        when p_type = 'PURCHASE_RETURN'     then 'PR'
        when p_type = 'STOCK_TRANSFER'      then 'ST'
        when p_type = 'GOODS_RECEIPT'       then 'STR'
        when p_type = 'DELIVERY'            then 'SI'
        when p_type = 'STOCK_ADJUSTMENT'    then 'SAJ'
        when p_type = 'CREDIT_NOTE'         then 'CN'
        when p_type = 'DEBIT_NOTE'          then 'DN'

        when p_type = 'PURCHASE_ORDER'      then 'PO'
        when p_type = 'SALES_ORDER'         then 'SO'
        when p_type = 'CASH_TRANSFER'       then 'CT'
        when p_type = 'OPENING_BALANCE'     then 'OB'
        when p_type = 'CONSIGNMENT_RECEIPT' then 'CNR'

        -- Not a document and never posted; numbered from the same series so
        -- a trip sheet reads like everything else on the yard.
        when p_type = 'DELIVERY_TRIP'       then 'TRP'
        else 'GEN'
    end;
$$;

-- ---------------------------------------------------------------- a view ---

-- A trip with its stops counted, which every screen showing trips needs and
-- none of them should count for itself.
create or replace view v_delivery_trip as
select t.id, t.company_id, t.trip_no, t.trip_date, t.status,
       t.location_id, t.vehicle_id, t.driver_id, t.salesman_id,
       t.departed_at, t.closed_at, t.note, t.created_at,
       l.code  as location_code, l.name as location_name,
       v.code  as vehicle_code,  v.plate_no,
       d.name  as driver_name,
       s.name  as salesman_name,
       count(st.id)                                            as stops,
       count(st.id) filter (where st.status = 'DELIVERED')      as delivered,
       count(st.id) filter (where st.status = 'FAILED')         as failed,
       count(st.id) filter (where st.status = 'PENDING')        as pending,
       coalesce(sum(doc.gross_total), 0)                        as goods_value
  from delivery_trip t
  left join location            l  on l.id  = t.location_id
  left join vehicle             v  on v.id  = t.vehicle_id
  left join driver              d  on d.id  = t.driver_id
  left join salesman            s  on s.id  = t.salesman_id
  left join delivery_trip_stop  st on st.trip_id = t.id
  left join document           doc on doc.id = st.document_id
 group by t.id, l.code, l.name, v.code, v.plate_no, d.name, s.name;
