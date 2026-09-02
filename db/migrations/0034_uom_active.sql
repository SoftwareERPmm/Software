-- Units can be retired.
--
-- Every other master here — brand, item_group, item, location, account —
-- carries is_active, and the reason is the same in each case: a unit that has
-- been used cannot be deleted, because items and document lines point at it
-- and the foreign key is there precisely to stop history losing its meaning.
-- Without is_active the only options were "delete it" (refused) and "leave it
-- in every picker forever", so a unit adopted by mistake stayed on offer for
-- the life of the company.
--
-- Additive and defaulted true, so every existing unit stays exactly as it is
-- and older code that never mentions the column keeps working.

alter table uom add column if not exists is_active boolean not null default true;

-- The pickers read by name, so an index on the flag alone would not earn its
-- keep. There are a handful of units per company; a sequential scan of four
-- rows is not worth an index.
