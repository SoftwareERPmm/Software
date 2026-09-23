-- A supplier is a kind of trade too.
--
-- 0092 gave customers a category — supermarket, township wholesaler,
-- traditional trade, pharmacy — and the table was named partner_category
-- rather than customer_category on the chance this would follow. It has.
--
-- Suppliers need the same thing and not the same list. "Supermarket"
-- describes a shop you sell to; "Importer", "Local manufacturer", "Agent"
-- describe who you buy from. They are two different questions about the same
-- company, and a single list mixing them would offer a buyer's clerk four
-- answers that are all wrong.
--
-- So the category gains a kind, and a partner gains a second column. That
-- matters because this system keeps one partner table with roles rather than
-- separate customer and supplier lists — the same company is routinely both,
-- and one that is needs to be filed twice: as the kind of shop it is when we
-- sell, and the kind of supplier it is when we buy. Nothing on the pilot is
-- both today, which is exactly when it is cheap to get right.
--
-- The four categories already on file are customer trade types, so they are
-- marked CUSTOMER. No partner's filing changes.

alter table partner_category
  add column if not exists kind text not null default 'CUSTOMER';

alter table partner_category drop constraint if exists partner_category_kind_check;
alter table partner_category add constraint partner_category_kind_check
  check (kind in ('CUSTOMER', 'SUPPLIER'));

comment on column partner_category.kind is
  'Which side of the trade this classification describes. A customer category '
  'answers "what kind of shop is this", a supplier category answers "what kind '
  'of supplier is this", and the two lists are never mixed on a picker.';

-- A code is unique per kind rather than per company: "AGENT" can reasonably
-- mean one thing among customers and another among suppliers.
alter table partner_category drop constraint if exists partner_category_company_id_code_key;
create unique index if not exists ux_partner_category_code
  on partner_category (company_id, kind, code);

alter table business_partner
  add column if not exists supplier_category_id uuid references partner_category(id);

comment on column business_partner.category_id is
  'What kind of shop this is, when we sell to them. The customer axis — see '
  'supplier_category_id for the other one.';
comment on column business_partner.supplier_category_id is
  'What kind of supplier this is, when we buy from them. Separate from '
  'category_id because a company that is both is two different things to us.';

create index if not exists ix_business_partner_supplier_category
  on business_partner (supplier_category_id) where supplier_category_id is not null;

-- Counts per side, so a screen can say how many suppliers sit in a supplier
-- category without counting the customers that never could.
-- Dropped and recreated: CREATE OR REPLACE VIEW cannot insert a column
-- mid-list, and kind belongs beside the other descriptive columns rather
-- than tacked on the end. Nothing depends on this view.
drop view if exists v_partner_category;

create view v_partner_category as
select c.id, c.company_id, c.code, c.name, c.name_my, c.note,
       c.kind, c.sort_order, c.is_active, c.created_at,
       (select count(*) from business_partner p
         where (c.kind = 'CUSTOMER' and p.category_id = c.id)
            or (c.kind = 'SUPPLIER' and p.supplier_category_id = c.id))   as partners,
       (select count(*) from business_partner p
         where c.kind = 'CUSTOMER' and p.category_id = c.id
           and p.is_customer and p.is_active)                             as customers,
       (select count(*) from business_partner p
         where c.kind = 'SUPPLIER' and p.supplier_category_id = c.id
           and p.is_supplier and p.is_active)                             as suppliers
  from partner_category c;
