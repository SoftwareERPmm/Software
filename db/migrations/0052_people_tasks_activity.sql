-- Who did it, who owes it, and what happened since.
--
-- Every document screen in this design is held together by attribution:
-- posted by Hla, responsible Su Su, created by Aung, an activity trail down
-- the side, a task with a deadline that turns the header amber when it
-- passes. None of that can be shown, because nothing in the database records
-- a person. Documents know when they were posted and nothing about by whom.
--
-- This is not the login system — that is still deferred. It is the thing the
-- login system will attach to when it arrives: a named person, referenced by
-- the documents they touched. Rows written before authentication exists carry
-- a name and no account, which is honest, and better than an audit trail that
-- says every document in the company was posted by nobody.

create table if not exists app_user (
    id          uuid primary key default gen_random_uuid(),
    company_id  uuid not null references company(id),
    name        text not null check (length(btrim(name)) > 0),
    -- Shown in the round avatar. Derived when not given, but stored, because
    -- "Su Su" is SS and "Aung" is A and no rule gets both right.
    initials    text not null check (length(btrim(initials)) between 1 and 3),
    email       text,
    is_active   boolean not null default true,
    created_at  timestamptz not null default now(),
    unique (company_id, name)
);

comment on table app_user is
    'A person this company''s work is attributed to. Not an account: there is '
    'no login yet, and this is what one will attach to when there is.';

-- Who raised it and who posted it. Nullable, and staying nullable: every
-- document that exists today was posted by somebody unrecorded, and filling
-- that in retrospectively with a guess would be worse than leaving it blank.
alter table document add column if not exists created_by_id uuid references app_user(id);
alter table document add column if not exists posted_by_id  uuid references app_user(id);

comment on column document.posted_by_id is
    'The person who posted it, where that was recorded. Null on everything '
    'from before people existed in this system — unattributed, not anonymous.';

-- ---------------------------------------------------------------------------
-- What somebody still has to do about this document.
--
-- "Invoice follow-up, Su Su, due 8 Sep" is not a status of the document: the
-- receipt is posted and complete in itself. It is a job attached to it, with
-- an owner and a deadline, and the deadline is what turns the banner amber.

create table if not exists document_task (
    id              uuid primary key default gen_random_uuid(),
    company_id      uuid not null references company(id),
    document_id     uuid not null references document(id),

    task            text not null check (length(btrim(task)) > 0),
    responsible_id  uuid references app_user(id),
    due_date        date,

    done_at         timestamptz,
    done_by_id      uuid references app_user(id),
    created_at      timestamptz not null default now(),

    -- One open task of a kind per document. A second "invoice follow-up" on
    -- the same receipt is the same job, listed twice.
    unique (document_id, task)
);

create index if not exists document_task_open_idx
    on document_task (company_id, due_date) where done_at is null;

comment on table document_task is
    'Work owed on a document — chasing an invoice, reconciling a payment — '
    'with the person who owes it and when it was due.';

-- ---------------------------------------------------------------------------
-- What has happened to this document, in order.
--
-- Some of it is derivable — a posted document was posted — but not all: a
-- payment created at 14:18 and posted at 14:20 by the same person is two
-- events, and "bank payment recorded" is a third that no column implies.
-- Append-only, because a history that can be edited is not one.

create table if not exists document_activity (
    id           uuid primary key default gen_random_uuid(),
    company_id   uuid not null references company(id),
    document_id  uuid not null references document(id),

    happened_at  timestamptz not null default now(),
    actor_id     uuid references app_user(id),

    -- A short machine-readable kind for the icon, and the sentence to show.
    kind         text not null,
    note         text,

    created_at   timestamptz not null default now()
);

create index if not exists document_activity_document_idx
    on document_activity (document_id, happened_at desc);

comment on table document_activity is
    'The trail down the side of a document: what happened, when, and who did '
    'it. Append-only.';

create or replace function fn_document_activity_immutable() returns trigger
language plpgsql as $$
begin
    raise exception 'Activity is append-only. Add a correcting entry instead.';
end;
$$;

drop trigger if exists trg_document_activity_immutable on document_activity;
create trigger trg_document_activity_immutable
    before update or delete on document_activity
    for each row execute function fn_document_activity_immutable();

-- ---------------------------------------------------------------------------
-- Payments somebody intends to make.
--
-- Kept apart from the payments that happened, and labelled that way on
-- screen, because the two being confusable is how a supplier gets paid twice:
-- a schedule is a plan, and a plan settles nothing.

create table if not exists payment_schedule (
    id            uuid primary key default gen_random_uuid(),
    company_id    uuid not null references company(id),
    schedule_no   text not null,
    partner_id    uuid not null references business_partner(id),
    -- What it is meant to pay, where that is known.
    invoice_id    uuid references document(id),

    planned_date  date not null,
    amount        numeric(18,4) not null check (amount > 0),

    -- The payment that carried it out, once one has.
    executed_by_document_id uuid references document(id),

    created_by_id uuid references app_user(id),
    created_at    timestamptz not null default now(),
    unique (company_id, schedule_no)
);

create index if not exists payment_schedule_partner_idx
    on payment_schedule (company_id, partner_id, planned_date);

comment on table payment_schedule is
    'A payment somebody plans to make. Never a payment: nothing here settles '
    'an invoice until a real one names it.';

-- Overdue is the same question everywhere: planned, not carried out, and the
-- date has gone.
create or replace view v_payment_schedule_status as
select ps.*,
       (ps.executed_by_document_id is not null) as executed,
       (ps.executed_by_document_id is null and ps.planned_date < current_date) as overdue
  from payment_schedule ps;
