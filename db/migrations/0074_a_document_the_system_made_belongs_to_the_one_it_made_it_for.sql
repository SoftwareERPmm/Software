-- A document the system made belongs to the one it made it for
--
-- Four postings create a second document on the user's behalf. A counter sale
-- composes the delivery that takes the stock out; a bill received now
-- composes the goods receipt that brings it in; cash taken on a sales invoice
-- composes the receipt, and cash paid on a purchase invoice the payment.
-- Nobody asked for any of them. They exist because the stock and the money
-- have to be recorded somewhere, and that somewhere is a document.
--
-- Undoing the parent then goes wrong in one of two ways, and both were live:
--
--   a counter sale on credit voided, and the delivery it made stayed posted.
--   Nothing pointed from the delivery back at the invoice, so no rule saw it.
--   The stock stayed out, COGS stayed booked, revenue was reversed, and the
--   books read as goods given away.
--
--   a counter sale in cash refused to void at all, because the receipt it
--   made does point back and the rule that sees it says "void that first" —
--   demanding somebody unpick a document they never created.
--
-- The missing fact is who made it. A delivery raised by a person, on its own
-- day, against an invoice is that person's document and must block: the goods
-- went, and no amount of undoing the paperwork brings them back. A delivery
-- the engine composed inside the same transaction as the invoice is part of
-- that invoice, and belongs with it wherever it goes. Both are DELIVERY rows
-- pointing at a SALES_INVOICE. Nothing in the data told them apart.
--
-- lifecycle_owner_id is that fact. Set, it names the document this one was
-- made for and follows it into a void. Null — every row today, and every
-- document a person creates — means what it has always meant.
--
-- One column rather than a mode and an owner. Two fields can disagree: AUTO
-- with no owner, MANUAL with one. Neither means anything, and both would have
-- to be guarded forever. A single nullable reference cannot contradict itself.

alter table document
  add column if not exists lifecycle_owner_id uuid references document(id);

comment on column document.lifecycle_owner_id is
    'The document this one was composed for, when the engine created it rather '
    'than a person: the delivery a counter sale writes, the goods receipt a '
    'bill received now writes, the receipt or payment cash on an invoice '
    'writes. Such a document is reversed with its owner rather than blocking '
    'it. Null for everything a person created, which is the ordinary case and '
    'every row written before this column existed.';

-- Read one way only: given a document being voided, what did it compose?
create index if not exists document_lifecycle_owner_idx
    on document (lifecycle_owner_id)
 where lifecycle_owner_id is not null;
