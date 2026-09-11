-- Where the cost of these goods actually went.
--
-- When a bill later corrects what a receipt's goods cost, the share belonging
-- to units already issued has to be adjusted somewhere — and the only right
-- answer is the account the original issue posted to. 0057 asked the item's
-- current mapping instead, which is the same answer only for as long as nobody
-- re-charts an item. Re-charting happens (scripts/load-coa.mjs exists for it),
-- and when it does, the correction lands in the new account while the entry it
-- is correcting sits in the old one: both wrong, permanently, and nothing on
-- either screen to suggest why.
--
-- It is not always cost of sales, which is the other reason to record it
-- rather than re-derive it. Goods given away post to the reason's own expense
-- account; goods written off post to stock adjustment. "The account this cost
-- went to" is the question, and the answer belongs with the consumption.
--
-- Null for everything consumed before this column existed, and for the two
-- cases where no expense was recognised: a transfer, which keeps the goods,
-- and a purchase return, which sends them back to the supplier. The correction
-- falls back to the item's current mapping when it is null and says so.

alter table stock_lot_consumption
    add column if not exists expense_account_id uuid references account(id);

comment on column stock_lot_consumption.expense_account_id is
    'The account this consumption charged the cost to — cost of sales, a '
    'free-goods reason, or stock adjustment. Recorded so a later correction '
    'to what the goods cost adjusts the account that was actually used, '
    'rather than whatever the item maps to by then.';

create index if not exists stock_lot_consumption_expense_idx
    on stock_lot_consumption (expense_account_id)
 where expense_account_id is not null;
