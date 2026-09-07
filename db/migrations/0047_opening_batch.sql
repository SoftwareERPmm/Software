-- The cutover: what the business already had on the day it started using this.
--
-- An existing company does not begin at nil. There is stock on the shelf,
-- customers who owe money, suppliers owed, cash in the till — none of it
-- produced by a document in this system, and all of it has to arrive without
-- pretending to be this period's trading.
--
-- Every route available before this was wrong in a way that balanced:
--
--   a stock adjustment credits Inventory Adjustment, which is cost of sales,
--   so opening stock made the first period's cost negative by its value;
--
--   a sales invoice credits revenue, so last year's unpaid sales became this
--   year's turnover, and a purchase invoice did the same to GR/IR;
--
--   a manual journal into Inventory moved no stock at all — the hole 0046
--   closed, which removed the wrong route without providing a right one.
--
-- What is correct: every opening figure balances against Opening Balance
-- Equity, which nets to nil once they are all in, and nothing touches
-- revenue, cost of sales or GR/IR. Stock arrives as stock, with quantity and
-- a FIFO layer a later sale can consume. Receivables and payables arrive as
-- open items carrying the customer's own reference and due date, so they age
-- correctly and can be settled by an ordinary receipt or payment.

create table if not exists opening_batch (
    id           uuid primary key default gen_random_uuid(),
    company_id   uuid not null references company(id),

    -- The day the business starts using this system. Every document in the
    -- batch is dated the day before, so the opening position is what was
    -- true when trading in this system began, and day one's own transactions
    -- do not compete with it for the same date.
    cutover_date date not null,

    status       text not null default 'DRAFT'
                 check (status in ('DRAFT', 'POSTED', 'REVERSED')),
    memo         text,
    created_at   timestamptz not null default now(),
    posted_at    timestamptz,

    check (status <> 'POSTED' or posted_at is not null)
);

comment on table opening_batch is
    'One cutover. Every opening document points at it, so the whole opening '
    'position can be checked as a unit and cannot be entered twice.';

-- One posted batch per company, and no more. This is the duplicate-import
-- guard, and it is a constraint rather than a check in application code
-- because the damage — a second set of opening balances silently doubling
-- stock and debts — is exactly the kind that is discovered months later.
create unique index if not exists opening_batch_one_posted_per_company
    on opening_batch (company_id) where status = 'POSTED';

alter table document
    add column if not exists opening_batch_id uuid references opening_batch(id);

comment on column document.opening_batch_id is
    'Set on every document a cutover produced. A sales invoice carrying one '
    'is an opening receivable, not a sale: it debits receivables and credits '
    'Opening Balance Equity, and no revenue was earned.';

create index if not exists document_opening_batch_idx
    on document (opening_batch_id) where opening_batch_id is not null;
