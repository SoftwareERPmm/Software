-- Voiding a posted document, and a log of what was done to it.
--
-- "Delete" and "edit" arrive as user-facing actions without history being
-- rewritten, because nothing here rewrites it. A void posts a reversing
-- entry, so every account nets to zero and both entries stay visible; an
-- edit is a void followed by a fresh document, chained to the one it
-- replaces. The trial balance still ties to the subledgers afterwards, and a
-- report printed last month still says what it said.
--
-- The guard is the interesting part. 0023 froze a posted document's status
-- precisely because flipping it to CANCELLED hid a receivable from
-- v_open_item while AR control still carried it. That hole must not reopen,
-- so the transition to REVERSED is allowed only when the reversal document
-- is named in the same statement. A status cannot be flipped on its own; the
-- entry that makes the ledger whole has to exist first.

-- ------------------------------------------------------------------ links --

alter table document
    add column if not exists reverses_document_id     uuid references document(id),
    add column if not exists reversed_by_document_id  uuid references document(id),
    add column if not exists supersedes_document_id   uuid references document(id),
    add column if not exists void_reason              text;

comment on column document.reverses_document_id is
    'Set on a reversal: the document it cancels out.';
comment on column document.reversed_by_document_id is
    'Set on the original when it is voided: the reversal that cancels it.';
comment on column document.supersedes_document_id is
    'Set on the replacement when a document is edited: the version it '
    'replaces. The replaced one is voided in the same transaction.';

create index if not exists document_reverses_idx
    on document (reverses_document_id) where reverses_document_id is not null;
create index if not exists document_supersedes_idx
    on document (supersedes_document_id) where supersedes_document_id is not null;

-- ---------------------------------------------------------------- history --

-- What was done, to what, when, and why. Append-only, like every other
-- record of something having happened.
create table if not exists document_history (
    id            uuid primary key default gen_random_uuid(),
    company_id    uuid not null references company(id),
    document_id   uuid not null references document(id),
    action        text not null check (action in ('VOID', 'AMEND')),

    -- Null until there is such a thing as a logged-in user. The column exists
    -- now so the shape of the table does not change when authentication
    -- arrives, and so a row written today is not silently reinterpreted later
    -- as having been done by whoever is added first.
    acted_by      uuid,

    reason        text,
    -- The reversal, or the replacement. Which one depends on `action`.
    related_id    uuid references document(id),
    -- What the document said before, so the log can show a change rather
    -- than just record that one happened.
    detail        jsonb,
    acted_at      timestamptz not null default now()
);

create index if not exists document_history_doc_idx
    on document_history (company_id, document_id, acted_at desc);
create index if not exists document_history_when_idx
    on document_history (company_id, acted_at desc);

comment on table document_history is
    'Every void and edit of a posted document. Append-only: it is the record '
    'of what was done, so it may not itself be edited.';

create or replace function fn_document_history_append_only() returns trigger
language plpgsql as $$
begin
    raise exception 'document_history records what happened and cannot be % ',
        lower(TG_OP);
end;
$$;

drop trigger if exists trg_document_history_append_only on document_history;
create trigger trg_document_history_append_only
    before update or delete on document_history
    for each row execute function fn_document_history_append_only();

-- ------------------------------------------------------------------ guard --

-- Replaces the 0023 function. Everything it refused, it still refuses; the
-- single addition is the transition a void needs, and that transition is only
-- legal with the reversal attached.
create or replace function fn_document_immutable() returns trigger
language plpgsql as $$
begin
    if (TG_OP = 'DELETE') then
        if OLD.status <> 'DRAFT' then
            raise exception
                'Document % is % and cannot be deleted. Void it instead — that '
                'posts a reversal and keeps both entries', OLD.doc_no, OLD.status;
        end if;
        return OLD;
    end if;

    -- No entry yet: the posting transaction is still assembling the document,
    -- which is exactly when the header legitimately changes.
    if OLD.journal_entry_id is null then
        return NEW;
    end if;

    -- The one permitted change to a posted document: it becomes REVERSED, and
    -- only together with the reversal that cancels it. Nothing else about it
    -- may move in the same statement — a void is not an opportunity to
    -- correct the total on the way past.
    if OLD.status = 'POSTED' and NEW.status = 'REVERSED'
       and OLD.reversed_by_document_id is null
       and NEW.reversed_by_document_id is not null
    then
        if NEW.company_id   is distinct from OLD.company_id
        or NEW.doc_type     is distinct from OLD.doc_type
        or NEW.doc_no       is distinct from OLD.doc_no
        or NEW.partner_id   is distinct from OLD.partner_id
        or NEW.doc_date     is distinct from OLD.doc_date
        or NEW.posting_date is distinct from OLD.posting_date
        or NEW.net_total    is distinct from OLD.net_total
        or NEW.tax_total    is distinct from OLD.tax_total
        or NEW.gross_total  is distinct from OLD.gross_total
        or NEW.journal_entry_id is distinct from OLD.journal_entry_id
        then
            raise exception
                'Voiding % may set the reversal and the reason, nothing else',
                OLD.doc_no;
        end if;
        return NEW;
    end if;

    if NEW.company_id     is distinct from OLD.company_id
    or NEW.doc_type       is distinct from OLD.doc_type
    or NEW.doc_no         is distinct from OLD.doc_no
    or NEW.partner_id     is distinct from OLD.partner_id
    or NEW.doc_date       is distinct from OLD.doc_date
    or NEW.posting_date   is distinct from OLD.posting_date
    or NEW.net_total      is distinct from OLD.net_total
    or NEW.tax_total      is distinct from OLD.tax_total
    or NEW.gross_total    is distinct from OLD.gross_total
    or NEW.status         is distinct from OLD.status
    or NEW.journal_entry_id is distinct from OLD.journal_entry_id
    then
        raise exception
            'Document % is posted; its totals, dates, partner and status are '
            'fixed. Void it, or post a correcting document instead',
            OLD.doc_no;
    end if;

    return NEW;
end;
$$;

-- A reversal must actually reverse something, and a document may only be
-- reversed once. Both are cheap to state here and impossible to get wrong
-- later.
create unique index if not exists document_reversed_once_idx
    on document (reversed_by_document_id) where reversed_by_document_id is not null;
