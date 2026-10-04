-- Which document's journal entry actually moved the cost.
--
-- Usually the invoice: it bills the goods, claims the layers and posts
-- Dr 5000 / Cr 1090 in one entry. But when the bill was raised first and
-- the goods followed, the delivery claims on the invoice's behalf and the
-- cost reaches 5000 in the *delivery's* entry, on the delivery's date.
--
-- The allocation row names the invoice line either way, which is right —
-- that is whose cost it is. What it could not say is where the entry went,
-- and the sales report needs to know: its accounting-period basis exists to
-- tie to the income statement, and attributing August's posting to a July
-- invoice would quietly stop it doing so.
--
-- Nothing is live on this yet, so the column is filled from the invoice and
-- made mandatory in the same breath rather than left nullable for a backfill
-- that would never come. The immutability trigger has to stand aside for
-- that one update; it goes straight back.

alter table sales_cost_allocation
  add column posted_by_document_id uuid references document(id);

drop trigger if exists trg_sales_cost_allocation_immutable on sales_cost_allocation;

-- Every row that exists today was written by an invoice claiming its own
-- goods, which is the ordinary case.
update sales_cost_allocation a
   set posted_by_document_id = dl.document_id
  from document_line dl
 where dl.id = a.invoice_line_id
   and a.posted_by_document_id is null;

alter table sales_cost_allocation
  alter column posted_by_document_id set not null;

create trigger trg_sales_cost_allocation_immutable
    before update or delete on sales_cost_allocation
    for each row execute function fn_sales_cost_allocation_immutable();

create index on sales_cost_allocation (posted_by_document_id);

comment on column sales_cost_allocation.posted_by_document_id is
  'The document whose journal entry carried this cost to 5000 — the invoice normally, the delivery where the bill came first.';
