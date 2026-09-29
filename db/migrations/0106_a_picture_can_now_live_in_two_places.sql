-- A picture can now live in two places, and the rule only knew one.
--
-- 0076 kept photo, photo_mime and photo_updated_at meaningful only together:
-- bytes with no type cannot be served, and a type with no bytes promises a
-- picture that is not there. Correct then, when the bytes were the only home.
--
-- 0105 gave the picture a second home — an object in the public bucket, named
-- by photo_key — and left that rule alone, so the first save through the new
-- path was refused by the old constraint: key and type and timestamp set,
-- bytes null, which the check reads as a promise with nothing behind it.
--
-- The rule it should have been all along is about the pair that matters: a
-- picture is somewhere, or it is nowhere. Where it is may be either column.
-- photo_mime and photo_updated_at travel with whichever one holds it.

alter table item drop constraint if exists item_photo_all_or_nothing;
alter table item add constraint item_photo_all_or_nothing check (
      (photo is null and photo_key is null
       and photo_mime is null and photo_updated_at is null)
   or ((photo is not null or photo_key is not null)
       and photo_mime is not null and photo_updated_at is not null)
);

comment on constraint item_photo_all_or_nothing on item is
    'A picture is somewhere or nowhere. Either the bytea from 0076 or the '
    'bucket key from 0105 may hold it — and whichever does, the type and the '
    'timestamp that describe it have to be there too.';
