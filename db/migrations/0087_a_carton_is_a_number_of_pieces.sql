-- A carton is a number of pieces, and the number belongs to the line.
--
-- item_uom has existed since the beginning with a factor column and no rows:
-- every document line so far records entered_qty = base_qty and the item's
-- own unit, which is to say every document is in pieces because nothing else
-- was possible. A distributor buys in cartons and sells in pieces, and until
-- now that arithmetic happened in somebody's head before they typed.
--
-- The factor goes on the line, not only on the item. ERPNext does the same
-- thing for the same reason: a pack size is a fact about the day a document
-- was written, and a supplier who changes from 24s to 20s next year must not
-- restate what last year's receipts meant. The master says what to offer;
-- the line says what was used.
--
-- Stock stays in the item's base unit throughout — one ledger, one unit, one
-- cost per unit. Only the document line is allowed to speak in cartons.

alter table document_line
  add column if not exists conversion_factor numeric(18,6) not null default 1;

alter table document_line drop constraint if exists document_line_conversion_factor_check;
alter table document_line add constraint document_line_conversion_factor_check
  check (conversion_factor > 0);

comment on column document_line.conversion_factor is
  'How many base units one entered unit is. 1 for a line typed in the item''s own unit, 24 for a line typed in cartons of 24. Recorded here so a later change to the pack size cannot restate what this document meant.';

comment on column document_line.entered_qty is
  'The quantity as typed, in entered_uom_id. base_qty is this multiplied by conversion_factor, and the stock ledger only ever sees base_qty.';

comment on column document_line.unit_price is
  'Price per entered unit — per carton on a line typed in cartons. Identical to the base-unit price whenever conversion_factor is 1, which is every line written before pack sizes existed.';

-- One row per pack per item, and never a row for the item's own unit: that
-- is the base, its factor is 1 by definition, and storing it invites two
-- answers to one question.
create unique index if not exists ux_item_uom_item_uom on item_uom (item_id, uom_id);

comment on table item_uom is
  'The packs an item can be bought and sold in, each with how many base units it holds. The item''s own base unit is not listed here — it is the unit everything converts to.';
