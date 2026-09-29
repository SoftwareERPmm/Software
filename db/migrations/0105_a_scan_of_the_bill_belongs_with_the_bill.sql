-- A scan of the bill belongs with the bill.
--
-- Two kinds of file, two homes, decided by who may see them.
--
-- A supplier's scanned invoice, a signed delivery note, a photograph of
-- damaged goods — these are evidence about a transaction. They are worth
-- keeping beside the document they belong to, and they are nobody else's
-- business, so they go in a private bucket and are only ever served through
-- this app. A product photograph is the opposite: it is a picture of a thing
-- anyone can buy, it is fetched on every catalogue page, and it costs
-- nothing if it leaks. That goes in a public bucket and is served straight
-- from the edge, which is the whole reason for having one.
--
-- Why a bucket at all, when 0076 argued the other way for item photos and
-- was right to. Its reasoning was that one backup restores the books and the
-- pictures together, and that an object store brings its own lifecycle to
-- drift out of step. Both still true. What changed is the size of the thing
-- being stored: a 512px thumbnail is 40KB and a scanned A4 invoice is two to
-- five megabytes. A thousand bills a year is several gigabytes inside every
-- backup, restore and branch of the database — which is the point where
-- keeping them in the row stops being simplicity and starts being a cost
-- paid on every operation. So attachments go out, and item photos follow
-- only because the public bucket is free to serve and they were never the
-- expensive half.
--
-- The drift 0076 warned about is real and is handled where it can be: the
-- row is the record, the object is the payload, and a row without its object
-- shows as a broken attachment rather than as a silent absence. Deleting the
-- object when the row goes is done by the application, not by the database,
-- because the database cannot reach the bucket.

create table if not exists document_attachment (
    id            uuid primary key default gen_random_uuid(),
    company_id    uuid not null references company(id) on delete cascade,
    document_id   uuid not null references document(id) on delete cascade,

    -- Where the bytes are, in the private bucket. Opaque to the database.
    r2_key        text not null unique,
    -- What the person called it, for the download. Never used as the key:
    -- a filename is somebody else's input and two can collide.
    filename      text not null,
    mime          text not null,
    size_bytes    bigint not null check (size_bytes > 0),
    /** What this is evidence of, in the uploader's words. Optional. */
    note          text,

    uploaded_at   timestamptz not null default now(),
    uploaded_by   uuid references app_user(id)
);

create index if not exists document_attachment_document_idx
    on document_attachment (document_id, uploaded_at desc);

comment on table document_attachment is
    'A file kept beside a document — a scanned bill, a signed delivery note. '
    'The bytes live in the private R2 bucket under r2_key; this row is the '
    'record that they exist and what they are.';

-- The item photo moves to the public bucket. The bytea column from 0076 is
-- left where it is rather than dropped: it holds nothing on any database
-- today, migrations here are additive so that older code ignores a new
-- column rather than breaking on a missing one, and a column that is never
-- written costs a query nothing. Whichever of the two is set is what the
-- app serves, key first.
alter table item
  add column if not exists photo_key text;

comment on column item.photo_key is
    'Object key in the public R2 bucket. When set it is the picture; the '
    'photo bytea column from 0076 is the older home and is no longer '
    'written to.';
