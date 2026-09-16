-- 0069_a_shortage_remembers_where_its_cost_went.sql
-- Where the provisional cost was charged, so the real one can follow it.
--
-- A normal issue records the account its cost went to: recordFifoConsumption
-- writes it onto the consumption, which is how a later revaluation finds its
-- way back to the right line of the P&L. A shortage had nowhere to write it.
-- It kept the quantity and the provisional unit cost and nothing about where
-- that cost landed.
--
-- So when the receipt finally arrived and the real cost was known, the
-- difference went to whatever the item's cost of sales resolves to *now*.
-- Three ways that is wrong:
--
--   Free goods. A giveaway is charged to the account its free-of-charge
--   reason names — samples, breakage, staff — and never to cost of sales.
--   The correction sent the difference to cost of sales anyway, so a sample
--   that turned out to cost more moved part of itself into the cost of
--   things that were sold.
--
--   Mappings that have since changed. An item regrouped between the sale and
--   the receipt gets its correction on the new account while the original
--   charge sits on the old one — two halves of one cost in two places, and
--   neither is wrong enough to be noticed.
--
--   Transfers. Moving stock between warehouses can go short too, and nothing
--   about a transfer is an expense: the goods are at the destination. Their
--   extra cost belongs in inventory there, not in cost of sales. Charging it
--   out means the receiving warehouse holds goods the books say cost less
--   than they did.
--
-- Nullable, because a transfer genuinely has no expense account — that is the
-- fact being recorded, not a gap. Null here means "this went to stock, not to
-- the P&L", and the settlement reads it that way.

alter table negative_stock
    add column if not exists expense_account_id uuid references account(id);

comment on column negative_stock.expense_account_id is
    'The account the provisional cost was charged to when the goods went out '
    '-- the free-of-charge reason''s account, or cost of sales as it resolved '
    'at the time. Null where nothing was expensed, which is what a transfer '
    'does: those goods are at the destination and their cost belongs to its '
    'inventory. Read when a later receipt settles the shortage, so the real '
    'cost lands where the provisional one did.';

-- Where a transfer's shortage ends up, so the settlement can put the extra
-- cost on the right shelf rather than the one the goods left.
alter table negative_stock
    add column if not exists to_location_id uuid references location(id);

comment on column negative_stock.to_location_id is
    'For a shortage created by a transfer, the warehouse the goods went to. '
    'Null for an issue that left the company. Used to value the destination '
    'when the real cost arrives.';

-- Rows written before these columns settle the way they always did. Their
-- cost went to the item's cost of sales, which is what a null expense account
-- and a null destination together mean for an issue that was not a transfer,
-- and the settlement falls back to exactly that.
