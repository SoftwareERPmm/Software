-- 5000 is where every delivery sends the cost of the goods that left. It
-- was called "Purchase", and its parent "Cost of Good Sold".
--
-- So the income statement printed "Purchase 30,000" for a period whose
-- purchases were 100,000 and whose cost of sales was 30,000. Anyone
-- checking the books against COGS = opening + purchases - closing reads
-- that line as purchases, finds it disagrees with everything, and
-- concludes the ledger is wrong. It is not: this is perpetual inventory,
-- a purchase goes to the Inventory asset and never to the income
-- statement, and 5000 holds cost of sales. Only the label lied.
--
-- A rename and nothing more. Nothing resolves an account by its name —
-- fn_resolve_account_for_item goes by role and posting rule, and the
-- code is unchanged — so no posting moves and no history is restated.
-- Companies that renamed it themselves are left alone.

update account
   set name = 'Cost of Goods Sold'
 where code = '5000'
   and name = 'Purchase';

update account
   set name = 'Cost of Goods Sold'
 where code = '5-CG'
   and name = 'Cost of Good Sold';
