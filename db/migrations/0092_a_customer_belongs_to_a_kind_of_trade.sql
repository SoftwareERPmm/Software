-- A customer belongs to a kind of trade.
--
-- Partners can already be grouped three ways: where they are (region and
-- township), what they pay (price level), and what they are to us (customer,
-- supplier, both). None of those answers the question a distributor actually
-- asks — what kind of shop is this. A supermarket chain, a township
-- wholesaler, a corner store and a pharmacy buy differently, are visited
-- differently and are worth different money, and today the only way to tell
-- them apart is to recognise the name.
--
-- Flat, not a tree. item_group nests because a catalogue is deep — Beverages
-- → Carbonated → Cola. Trade channel is not: a shop is a supermarket or it
-- is not, and the second level would be filled with guesses. If nesting is
-- ever wanted, a parent_id is an additive migration; taking one away is not.
--
-- Classification only. It sets no price, no credit limit and no terms, and
-- nothing posts differently because of it. Those already live on the
-- customer, where somebody agreed them with that shop, and a category that
-- quietly overrode them would make one customer's terms depend on a field
-- edited on a different screen.

create table if not exists partner_category (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references company(id) on delete cascade,
  code         text not null,
  name         text not null,
  name_my      text,
  note         text,
  -- What order they read in on a report, so the biggest channel is not
  -- wherever the alphabet puts it.
  sort_order   integer not null default 0,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (company_id, code)
);

-- Nullable, and it stays nullable. Every customer already on the books
-- predates this, and forcing a category would mean either a migration that
-- guesses or a screen that will not save until somebody guesses.
alter table business_partner
  add column if not exists category_id uuid references partner_category(id);

create index if not exists ix_business_partner_category
  on business_partner (category_id) where category_id is not null;

-- Categories with how many partners sit in each, which every screen showing
-- them needs and none of them should count for itself.
create or replace view v_partner_category as
select c.id, c.company_id, c.code, c.name, c.name_my, c.note,
       c.sort_order, c.is_active, c.created_at,
       (select count(*) from business_partner p
         where p.category_id = c.id)                        as partners,
       (select count(*) from business_partner p
         where p.category_id = c.id and p.is_customer
           and p.is_active)                                 as customers
  from partner_category c;
