-- A note says which kind of wrong it is fixing.
--
-- Credit and debit notes are raised for four quite different reasons, and
-- the free-text sentence on the note is where that difference currently
-- lives. It reads fine one note at a time and answers nothing across a
-- year: how much did we give away in goodwill discounts, how much went back
-- as billing errors, is one customer's account mostly corrections.
--
-- So the reason is categorised as well as written. The sentence stays — a
-- category is not an explanation — but the category is what a report can
-- count.
--
--   RETURN         goods the customer kept or destroyed, not coming back
--   BILLING_ERROR  overcharge, wrong price, duplicate billing
--   CANCELLATION   billed, then not delivered or called off
--   DISCOUNT       a reduction agreed after the invoice
--   OTHER          none of those, and the sentence has to carry it
--
-- RETURN is deliberately worded for goods that are NOT coming back. Goods
-- physically returning is a sales or purchase return, which moves the stock
-- and its cost; a note that quietly stood in for one would leave the
-- warehouse right and the books wrong, or the reverse.

alter table document
  add column if not exists adjustment_reason text;

alter table document drop constraint if exists document_adjustment_reason_check;
alter table document add constraint document_adjustment_reason_check check (
  adjustment_reason is null
  or adjustment_reason in ('RETURN', 'BILLING_ERROR', 'CANCELLATION', 'DISCOUNT', 'OTHER')
);

comment on column document.adjustment_reason is
  'Which kind of correction a credit or debit note is: RETURN, BILLING_ERROR, CANCELLATION, DISCOUNT or OTHER. Null on every other document type, and on notes raised before categories existed.';

create index if not exists ix_document_adjustment_reason
    on document (company_id, adjustment_reason) where adjustment_reason is not null;
