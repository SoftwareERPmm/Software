-- Most things come from a supplier at the usual speed, and some do not.
--
-- business_partner.lead_time_days (0108) says how long this supplier
-- generally takes, and it answers for nearly everything they sell. But one
-- product is made to order while the rest sit in their warehouse, and a
-- single number for the supplier cannot say that.
--
-- So: an exception table. A row here exists only where an item departs from
-- its supplier's usual speed, which keeps the data entry proportional to
-- the number of genuine exceptions rather than to the size of the
-- catalogue. Nothing breaks when it is empty, which is how it starts.
--
--   company.default_lead_time_days   what to assume knowing nothing
--   business_partner.lead_time_days  what this supplier usually takes
--   supplier_item.lead_time_days     what this item from them takes
--
-- Read most specific first. Each level is nullable and falls through.
--
-- Deliberately separate from what the receipts say actually happened.
-- Measured performance informs the person who set these; it does not
-- quietly rewrite them, or the number on the screen stops being anybody's
-- decision and nobody can say why the system ordered what it ordered.

create table if not exists supplier_item (
    id           uuid primary key default gen_random_uuid(),
    company_id   uuid not null references company(id) on delete cascade,
    supplier_id  uuid not null references business_partner(id) on delete cascade,
    item_id      uuid not null references item(id) on delete cascade,

    /** Null is not "zero days" — it is "no exception", and the supplier's
     *  own figure answers instead. */
    lead_time_days int,

    /** What the supplier calls it on their own paperwork, which is rarely
     *  what we call it. Nothing reads this yet; it is the other half of why
     *  a supplier-item row is worth having. */
    supplier_sku text,

    note        text,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),

    unique (company_id, supplier_id, item_id)
);

alter table supplier_item drop constraint if exists supplier_item_lead_time_sane;
alter table supplier_item add constraint supplier_item_lead_time_sane
  check (lead_time_days is null or (lead_time_days >= 0 and lead_time_days <= 365));

create index if not exists supplier_item_item_idx on supplier_item (item_id);

comment on table supplier_item is
    'Purchasing settings for one item from one supplier, recorded only where '
    'they differ from that supplier''s usual terms. Absent means "the usual".';

comment on column supplier_item.lead_time_days is
    'Expected days from order to arrival for this item from this supplier. '
    'Null falls back to business_partner.lead_time_days, then to '
    'company.default_lead_time_days. This is the planned figure the '
    'replenishment suggestion uses — what actually happened is measured '
    'separately from purchase orders and receipts, and never overwrites it.';
