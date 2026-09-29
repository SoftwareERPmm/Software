-- A shirt is one product and twelve things on a shelf.
--
-- A polo shirt in four sizes and three colours is one thing to a customer
-- asking for it and twelve things to a warehouse counting them. Stock, cost,
-- price and barcode all belong to the twelve; the name, the photograph and
-- the category belong to the one.
--
-- The variant is an item row, and that is the whole design decision. Twenty
-- one tables and views key on item_id and the posting engine names it three
-- hundred and fifty four times — stock movements, FIFO layers, prices,
-- document lines, serials, reorder points. A separate variant table would
-- mean carrying variant_id beside item_id through every one of them and
-- reworking the engine to match. Making the variant an ordinary item instead
-- costs nothing there: "Red / M" has its own stock and its own cost because
-- it is an item, and every screen that already works keeps working.
--
-- What the item table gains is a parent. Nullable, self-referencing, and the
-- common case leaves it null: an item with no parent and no children is an
-- ordinary item and behaves exactly as it did yesterday. A tin of condensed
-- milk is not going to acquire a size.
--
-- The attributes are master data rather than text typed on each product, so
-- that Red is one colour rather than four spellings of one, and so that
-- "which colours sold" is a question with an answer.

-- ---------------------------------------------------------------- lists ---

create table if not exists variant_attribute (
    id          uuid primary key default gen_random_uuid(),
    company_id  uuid not null references company(id) on delete cascade,
    code        text not null,
    name        text not null,
    name_my     text,
    sort_order  int  not null default 0,
    is_active   boolean not null default true,
    created_at  timestamptz not null default now(),
    unique (company_id, code)
);

comment on table variant_attribute is
    'A way products vary — Size, Colour, Material. Master data, so the same '
    'value means the same thing across the catalogue.';

create table if not exists variant_option (
    id            uuid primary key default gen_random_uuid(),
    company_id    uuid not null references company(id) on delete cascade,
    attribute_id  uuid not null references variant_attribute(id) on delete cascade,
    code          text not null,
    name          text not null,
    name_my       text,
    sort_order    int  not null default 0,
    is_active     boolean not null default true,
    created_at    timestamptz not null default now(),
    -- Sorted by hand rather than alphabetically: S, M, L, XL is the order a
    -- person expects and is not the order a computer would choose.
    unique (attribute_id, code)
);

comment on table variant_option is
    'One value of an attribute — M, or Red. sort_order is set by hand '
    'because S/M/L/XL is not alphabetical.';

-- --------------------------------------------------------------- parent ---

alter table item
  add column if not exists parent_item_id uuid references item(id);

create index if not exists item_parent_idx on item (parent_item_id)
  where parent_item_id is not null;

comment on column item.parent_item_id is
    'The product this is a variant of. Null for an ordinary item, which is '
    'most of them. A row with children is a parent and is not itself sold.';

-- A parent cannot be a variant of something else: one level, because two
-- would mean deciding what a grandchild''s stock belongs to and nobody has
-- asked for that.
alter table item drop constraint if exists item_parent_not_nested;
alter table item add constraint item_parent_not_nested
  check (parent_item_id is null or parent_item_id <> id);

-- Which attributes a given parent varies by, and in what order they read.
create table if not exists item_variant_attribute (
    item_id       uuid not null references item(id) on delete cascade,
    attribute_id  uuid not null references variant_attribute(id),
    sort_order    int  not null default 0,
    primary key (item_id, attribute_id)
);

-- Which option each variant is. One row per attribute the parent varies by.
create table if not exists item_variant_option (
    item_id    uuid not null references item(id) on delete cascade,
    option_id  uuid not null references variant_option(id),
    primary key (item_id, option_id)
);

create index if not exists item_variant_option_option_idx
  on item_variant_option (option_id);

comment on table item_variant_option is
    'What this variant is: the Size row and the Colour row that together say '
    '"M, Red". Reporting by colour reads this.';

-- ------------------------------------------------------------- the guard --

-- A parent is a name for a group, not a thing on a shelf. Selling "Polo
-- Shirt" without saying which one is an instruction the warehouse cannot
-- follow, and it would take stock from a row that never has any.
--
-- In the database rather than in the forms, for the same reason every other
-- rule here is: an import, a script or a form written next year would
-- otherwise each have to remember.
create or replace function fn_document_line_not_parent() returns trigger
language plpgsql as $$
begin
    if exists (select 1 from item c where c.parent_item_id = new.item_id) then
        raise exception
            'Line %: % is a product with variants, not something that can be '
            'sold or received on its own. Choose the size or colour wanted.',
            new.line_no,
            (select code from item where id = new.item_id);
    end if;
    return new;
end;
$$;

drop trigger if exists trg_document_line_not_parent on document_line;
create trigger trg_document_line_not_parent
    before insert on document_line
    for each row when (new.item_id is not null)
    execute function fn_document_line_not_parent();
