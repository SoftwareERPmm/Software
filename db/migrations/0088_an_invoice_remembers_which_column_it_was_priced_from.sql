-- An invoice remembers which column of the price list it was priced from.
--
-- The line records what was charged, which is the figure that matters and
-- the one the ledger uses. What it cannot say is why: 1,500 a box is the
-- wholesale price today, and next month it may be the retail price, and an
-- argument about whether a customer was billed correctly then has nothing to
-- read. The level is a fact about the sale, so it belongs on the sale.
--
-- Null on every invoice raised before this, and on any raised without a
-- price list — not "wholesale by default", because a guess written into a
-- document is worse than a blank somebody can interpret.

alter table document
  add column if not exists price_level_id uuid references price_level(id);

comment on column document.price_level_id is
  'Which column of the price list filled this document''s prices. A record of what was applied, not a control: the line''s own price is what was charged, whatever the list says now.';

create index if not exists ix_document_price_level
    on document (company_id, price_level_id) where price_level_id is not null;
