-- Importing items and opening stock from a spreadsheet.
--
-- Two things the importer needs that the schema does not yet have.
--
-- 1. A barcode.
--
-- An item's `code` is composed by trigger from its category's segment and its
-- serial (BEV + 001 -> BEV001), so it cannot be used as the identifier in an
-- import file: the customer would have to know the scheme to write the sheet,
-- and any code they typed would be overwritten. A barcode is the identifier
-- the trade already uses, it belongs to the goods rather than to our
-- numbering, and it gives the importer a stable way to tell "this row is the
-- item I already have" from "this row is new".
--
-- Nullable, because items that have never carried a barcode are legitimate
-- and every existing row is one. Unique per company where present, so two
-- items can never claim the same barcode — which is the whole point of using
-- it to match on.
alter table item add column barcode text;

create unique index item_barcode_unique
    on item (company_id, barcode)
 where barcode is not null;

comment on column item.barcode is
    'The barcode printed on the goods. Optional, unique within the company '
    'when set. Used to match a spreadsheet row to an existing item; the '
    'composed `code` cannot serve that purpose because it is derived.';

-- 2. A record of each import.
--
-- An import creates master data and posts stock in one act, and "what did
-- that spreadsheet actually do?" has to be answerable afterwards. Counts
-- alone would not answer it, so the rows an import creates point back at the
-- batch that created them and the question becomes a query rather than a
-- stored summary that could drift from the truth.
create table import_batch (
    id            uuid primary key default gen_random_uuid(),
    company_id    uuid not null references company(id),
    ref           text not null,
    filename      text not null,

    -- Rows read from the file, including any the user later fixed. Kept
    -- because "500 rows in, 470 stock records out" is the first thing
    -- somebody checks when a number looks wrong.
    row_count     integer not null default 0,

    status        text not null default 'COMPLETED'
        check (status in ('COMPLETED', 'FAILED')),
    error         text,

    created_at    timestamptz not null default now(),
    created_by    uuid,

    unique (company_id, ref)
);

-- What the batch made. Null for everything created any other way, which is
-- almost everything — these are deliberately not "the import's tables", just
-- a note on rows that happen to have come from one.
alter table item     add column import_batch_id uuid references import_batch(id);
alter table document add column import_batch_id uuid references import_batch(id);

create index item_import_batch_idx     on item (import_batch_id)     where import_batch_id is not null;
create index document_import_batch_idx on document (import_batch_id) where import_batch_id is not null;
