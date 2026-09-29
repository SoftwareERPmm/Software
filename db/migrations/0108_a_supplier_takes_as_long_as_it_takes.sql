-- A supplier takes as long as it takes, and ordering without knowing is guessing.
--
-- "This will run out in three days" is only worth reading beside "and this
-- supplier takes ten": the two together are what make a date to order by.
-- Nothing recorded how long anybody takes, so a suggestion could say what to
-- buy and never when — which is the half people actually act on.
--
-- Nullable on the partner and defaulted on the company, because a business
-- knows roughly how long deliveries take long before it knows it supplier by
-- supplier. A figure nobody has filled in should fall back to something
-- sensible rather than stop the calculation.

alter table business_partner
  add column if not exists lead_time_days int;

alter table business_partner drop constraint if exists business_partner_lead_time_sane;
alter table business_partner add constraint business_partner_lead_time_sane
  check (lead_time_days is null or (lead_time_days >= 0 and lead_time_days <= 365));

comment on column business_partner.lead_time_days is
  'Days between placing an order with this supplier and the goods arriving. '
  'Null means the company default is used — most suppliers will never have '
  'one of their own, and that is fine.';

alter table company
  add column if not exists default_lead_time_days int not null default 7;

alter table company drop constraint if exists company_default_lead_time_sane;
alter table company add constraint company_default_lead_time_sane
  check (default_lead_time_days >= 0 and default_lead_time_days <= 365);

comment on column company.default_lead_time_days is
  'What to assume when the supplier has no lead time of its own, and for an '
  'item nobody has bought yet so there is no supplier to ask.';
