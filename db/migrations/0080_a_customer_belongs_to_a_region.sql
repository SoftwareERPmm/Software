-- A customer belongs to a region, and a township is not one.
--
-- business_partner.township already existed and is used for the address on
-- printed documents. It is free text, which is right for "Hlaing" or "Bahan"
-- but wrong for the question "how much did we sell in Yangon" — three people
-- typing Yangon, yangon and Yangon Region make three answers, and a genuine
-- township entry never rolls up to the region containing it at all.
--
-- So region is its own column, constrained to Myanmar's fourteen states and
-- regions plus the union territory. NULL is allowed and is the starting
-- state for every existing partner: a region nobody has set is honestly
-- unknown, not a guess, and the dashboard says so rather than inventing one.

alter table business_partner add column if not exists region text;

alter table business_partner drop constraint if exists business_partner_region_check;
alter table business_partner add constraint business_partner_region_check check (
  region is null or region in (
    -- Regions
    'Ayeyarwady', 'Bago', 'Magway', 'Mandalay', 'Sagaing', 'Tanintharyi', 'Yangon',
    -- States
    'Chin', 'Kachin', 'Kayah', 'Kayin', 'Mon', 'Rakhine', 'Shan',
    -- Union territory
    'Naypyitaw'
  )
);

comment on column business_partner.region is
  'State or region, from a fixed list. Grouping dimension for reporting; township stays free text for the address line.';

-- Revenue by region is read per partner on a dashboard that loads it on every
-- view, so the join has an index to sit on.
create index if not exists ix_business_partner_region
    on business_partner (company_id, region) where region is not null;
