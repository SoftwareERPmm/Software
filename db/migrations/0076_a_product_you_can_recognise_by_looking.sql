-- A product you can recognise by looking
--
-- A catalogue of 010101001, 010101002, 010101003 is a catalogue you read
-- rather than recognise. Names help and run out: four handsets from one maker
-- differ by a word at the end, and six shades of the same case differ by
-- nothing you can write down. A thumbnail is the fastest way a person tells
-- one row from another, and the slowest thing to describe in text.
--
-- Optional, and meant to stay that way. A trading company with eight hundred
-- items is not going to photograph them, and nothing anywhere should require
-- it to. An item with no photo is an ordinary item.
--
-- Kept in the row rather than in a bucket. Postgres stores a value this size
-- out of line and reads it only when it is selected, so a column nobody lists
-- costs the catalogue query nothing — and the alternative is an object store
-- with its own credentials, its own lifecycle and its own way of drifting out
-- of step with the database that is supposed to own the record. One backup
-- restores the books and the pictures together, which is the property worth
-- having.

alter table item
  add column if not exists photo            bytea,
  add column if not exists photo_mime       text,
  add column if not exists photo_updated_at timestamptz;

comment on column item.photo is
    'A small picture of the product, re-encoded on the way in — never the '
    'file as uploaded. Optional; most items have none.';
comment on column item.photo_updated_at is
    'When the current picture was stored. Doubles as the cache key: the URL '
    'that serves it carries this, so a replaced photo is a different URL and '
    'no browser shows the old one.';

-- Three columns that only mean anything together. Bytes with no type cannot
-- be served, and a type with no bytes is a promise of a picture that is not
-- there.
alter table item drop constraint if exists item_photo_all_or_nothing;
alter table item add constraint item_photo_all_or_nothing check (
      (photo is null     and photo_mime is null     and photo_updated_at is null)
   or (photo is not null and photo_mime is not null and photo_updated_at is not null)
);

-- What the server is willing to have produced. This does not police what
-- somebody uploaded — that is checked before it gets here, and the file is
-- re-encoded rather than trusted. It polices what we wrote, so a bug that
-- stored a PDF under an image's name cannot be served back as one.
alter table item drop constraint if exists item_photo_is_an_image;
alter table item add constraint item_photo_is_an_image check (
    photo_mime is null or photo_mime in ('image/webp', 'image/png', 'image/jpeg')
);
