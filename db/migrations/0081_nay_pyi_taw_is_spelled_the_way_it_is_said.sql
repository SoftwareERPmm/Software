-- Nay Pyi Taw, in three words.
--
-- 0080 wrote the union territory as "Naypyitaw", one of several spellings in
-- circulation. The one used here is the one used in the country itself, and
-- this is a list Myanmar users read every time they file a customer — so it
-- is worth the second migration rather than living with a spelling nobody
-- writes by hand.
--
-- Nothing is stored under the old spelling yet; the update runs anyway, so
-- this migration is correct whenever it is applied rather than only today.

update business_partner set region = 'Nay Pyi Taw' where region = 'Naypyitaw';

alter table business_partner drop constraint if exists business_partner_region_check;
alter table business_partner add constraint business_partner_region_check check (
  region is null or region in (
    -- Regions
    'Ayeyarwady', 'Bago', 'Magway', 'Mandalay', 'Sagaing', 'Tanintharyi', 'Yangon',
    -- States
    'Chin', 'Kachin', 'Kayah', 'Kayin', 'Mon', 'Rakhine', 'Shan',
    -- Union territory
    'Nay Pyi Taw'
  )
);
