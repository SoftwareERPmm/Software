-- Selling goods the ERP has not been told about yet.
--
-- The situation is ordinary in a real warehouse: the stock is physically
-- there, the paperwork is not. Until now the delivery was simply refused,
-- which meant either inventing a receipt to get past it — a fabricated
-- document, with a made-up cost, that nobody would later recognise as
-- fabricated — or not invoicing goods the customer has already taken.
--
-- So the issue is allowed, deliberately and on the record:
--
--   * it must be confirmed at the time, and the confirmation is stored on the
--     document rather than assumed from the fact that it posted
--   * the uncovered quantity is recorded here, with the provisional cost it
--     was charged out at
--   * the next receipt of that item into that location settles it at the
--     receipt's real cost, and the difference between provisional and actual
--     goes to variance — the same treatment a purchase price difference gets
--
-- What this is not is permission for stock to drift negative quietly.
-- Negative stock is a state with a name, a cause, a confirmation, and a
-- worklist: Negative Stock — Pending Reconciliation.

-- --------------------------------------------------------- confirmation --

alter table document
    add column if not exists negative_stock_confirmed boolean not null default false,
    add column if not exists negative_stock_confirmed_at timestamptz,
    -- Null until there is a login to attribute it to. The column exists now so
    -- a confirmation made once there is one carries a name, and these keep
    -- their honest blank rather than being attributed to whoever comes first.
    add column if not exists negative_stock_confirmed_by uuid;

comment on column document.negative_stock_confirmed is
    'Someone confirmed the goods physically exist despite the ERP recording '
    'none. Set only on a document that actually drove stock negative.';

-- ------------------------------------------------------------ shortfall --

-- One row per item, location and document that issued more than was recorded.
create table if not exists negative_stock (
    id           uuid primary key default gen_random_uuid(),
    company_id   uuid not null references company(id),
    item_id      uuid not null references item(id),
    location_id  uuid not null references location(id),
    -- What issued it. Kept so the worklist can say which sale caused this,
    -- rather than presenting an unexplained negative balance.
    document_id  uuid not null references document(id),

    qty          numeric(18,4) not null check (qty > 0),
    -- What the goods were charged to COGS at, having no layer to draw from.
    -- The figure that gets trued up when the real cost is known.
    provisional_unit_cost numeric(18,4) not null,

    created_at   timestamptz not null default now()
);

create index if not exists negative_stock_open_idx
    on negative_stock (company_id, item_id, location_id);

comment on table negative_stock is
    'Quantities issued that no cost layer covered. Outstanding until a receipt '
    'settles them — remaining is qty less settlements, never stored.';

-- Settlements against it, in the same shape as stock_lot_consumption: the
-- outstanding quantity is qty less the sum of these, derived and never
-- stored, so it cannot drift from the rows that explain it.
create table if not exists negative_stock_settlement (
    id                 uuid primary key default gen_random_uuid(),
    company_id         uuid not null references company(id),
    negative_stock_id  uuid not null references negative_stock(id),
    -- The receipt that covered it.
    document_id        uuid not null references document(id),
    stock_movement_id  uuid references stock_movement(id),

    qty                numeric(18,4) not null check (qty > 0),
    -- What it actually cost, from the receipt. The difference against
    -- provisional_unit_cost is the variance posted at settlement.
    actual_unit_cost   numeric(18,4) not null,

    created_at         timestamptz not null default now()
);

create index if not exists negative_stock_settlement_idx
    on negative_stock_settlement (negative_stock_id);

-- Append-only, like every other record of something having happened.
create or replace function fn_negative_stock_append_only() returns trigger
language plpgsql as $$
begin
    raise exception 'negative stock records what happened and cannot be %',
        lower(TG_OP);
end;
$$;

drop trigger if exists trg_negative_stock_append_only on negative_stock;
create trigger trg_negative_stock_append_only
    before update or delete on negative_stock
    for each row execute function fn_negative_stock_append_only();

drop trigger if exists trg_negative_stock_settlement_append_only on negative_stock_settlement;
create trigger trg_negative_stock_settlement_append_only
    before update or delete on negative_stock_settlement
    for each row execute function fn_negative_stock_append_only();

-- ------------------------------------------------------------ worklist --

create or replace view v_negative_stock as
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
    ns.created_at
  from negative_stock ns
  join item i     on i.id = ns.item_id
  join location l on l.id = ns.location_id
  join document d on d.id = ns.document_id
  left join (
        select negative_stock_id, sum(qty) as settled
          from negative_stock_settlement group by negative_stock_id
  ) s on s.negative_stock_id = ns.id
 where ns.qty - coalesce(s.settled, 0) > 0.0001;

comment on view v_negative_stock is
    'Negative Stock — Pending Reconciliation. Stock issued that no receipt '
    'had covered, still awaiting one.';
