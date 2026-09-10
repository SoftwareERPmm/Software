-- An edit is a new version of the same document, not a new document.
--
-- Editing already worked in principle — 0037 made a correction a void plus a
-- replacement, chained by supersedes_document_id, with an append-only history
-- of what changed. What it did not do is keep the identity. The replacement
-- was numbered afresh, so SI20260910001 became SI20260910007 and the customer
-- holding a piece of paper with the first number on it had nothing to match.
-- The tester asked for the thing everyone actually expects: the number stays,
-- and it is now at v2.
--
-- So a document number identifies a document across its versions, and the
-- version says which one you are looking at. Exactly one version of a number
-- is live; the others are history, readable and never edited.
--
--     SI20260910001  v2  POSTED     12,000   <- what the invoice says now
--     SI20260910001  v1  REVERSED   10,000   <- superseded, kept, read-only
--
-- Two things it deliberately does not do:
--
-- It does not relax the ledger. An invoice's v2 is still a fresh posting and
-- v1 is still reversed by a real reversing entry — the trial balance ties at
-- every moment, and a report printed before the edit still says what it said.
--
-- And it does not make stock editable. A receipt or a delivery that moved
-- goods cannot be superseded, for the same reason it cannot be voided: the
-- cost layers it created have been consumed by other documents. Correcting
-- those is a return, and that stays true. Versioning is for the documents
-- that carry intent and money — orders and invoices.

alter table document
    add column if not exists version int not null default 1,
    add column if not exists superseded_by_document_id uuid references document(id);

comment on column document.version is
    'Which version of this document number this row is. Version 1 is the '
    'original; an edit posts the next one under the same number.';
comment on column document.superseded_by_document_id is
    'Set on a version that has been replaced: the version that replaced it. '
    'The mirror of supersedes_document_id, so the chain reads both ways '
    'without a join through every document in the company.';

create index if not exists document_superseded_by_idx
    on document (superseded_by_document_id) where superseded_by_document_id is not null;

-- A number and a version identify a row. Two v2s of one invoice is a
-- contradiction, not a history.
create unique index if not exists document_no_version_uidx
    on document (company_id, doc_no, version) where doc_no is not null;

-- And only one version of a number is live at a time. This is the invariant
-- the whole scheme rests on: without it, an edit that half-failed leaves two
-- documents claiming to be SI20260910001, and every list shows both.
create unique index if not exists document_live_version_uidx
    on document (company_id, doc_no)
 where doc_no is not null and status = 'POSTED';

-- What version each number is on, and what came before. One place to ask, so
-- a badge on a screen and a check in the engine cannot disagree.
create or replace view v_document_version as
select d.id,
       d.company_id,
       d.doc_no,
       d.doc_type,
       d.version,
       d.status,
       d.supersedes_document_id,
       d.superseded_by_document_id,
       (d.superseded_by_document_id is null and d.status = 'POSTED') as is_current,
       (select max(v.version) from document v
         where v.company_id = d.company_id and v.doc_no = d.doc_no) as latest_version,
       (select count(*)::int from document v
         where v.company_id = d.company_id and v.doc_no = d.doc_no) as version_count
  from document d
 where d.doc_no is not null;

comment on view v_document_version is
    'Where a document sits among the versions of its number: which version it '
    'is, whether it is the live one, and how many exist.';

-- ---------------------------------------------------------------------------
-- The freeze, extended by exactly one permitted transition.
--
-- 0023 froze a posted document and 0037 allowed one exception — becoming
-- REVERSED, and only in the same statement as the reversal that cancels it.
-- Superseding needs the same shape: a document may be marked as replaced, and
-- only together with the replacement that replaces it. Nothing else about it
-- may move on the way past, because an edit is not an opportunity to quietly
-- restate the original.

-- Replaces the 0037 function. Everything it refused, it still refuses; the
-- single addition is the transition an edit needs, and that transition is
-- only legal with the replacement attached.
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
    -- which is exactly when the header legitimately changes. An order never
    -- acquires one, which is why an order can be superseded without a
    -- reversal — there is no entry to reverse.
    if OLD.journal_entry_id is null then
        return NEW;
    end if;

    -- The permitted change to a posted document: it becomes REVERSED, and
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
        or NEW.version      is distinct from OLD.version
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

    -- The addition: a reversed version learns which version replaced it. Only
    -- that column moves, and only from empty — a document is superseded once.
    if OLD.superseded_by_document_id is null
       and NEW.superseded_by_document_id is not null
    then
        if NEW.company_id   is distinct from OLD.company_id
        or NEW.doc_type     is distinct from OLD.doc_type
        or NEW.doc_no       is distinct from OLD.doc_no
        or NEW.version      is distinct from OLD.version
        or NEW.partner_id   is distinct from OLD.partner_id
        or NEW.doc_date     is distinct from OLD.doc_date
        or NEW.posting_date is distinct from OLD.posting_date
        or NEW.net_total    is distinct from OLD.net_total
        or NEW.tax_total    is distinct from OLD.tax_total
        or NEW.gross_total  is distinct from OLD.gross_total
        or NEW.status       is distinct from OLD.status
        or NEW.journal_entry_id is distinct from OLD.journal_entry_id
        then
            raise exception
                'Superseding % may set the replacement, nothing else', OLD.doc_no;
        end if;
        return NEW;
    end if;

    if NEW.company_id     is distinct from OLD.company_id
    or NEW.doc_type       is distinct from OLD.doc_type
    or NEW.doc_no         is distinct from OLD.doc_no
    or NEW.version        is distinct from OLD.version
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
            'fixed. Void it, or edit it — an edit posts the next version under '
            'the same number and keeps this one', OLD.doc_no;
    end if;

    return NEW;
end;
$$;

-- A version is superseded once, by one replacement.
create unique index if not exists document_superseded_once_idx
    on document (superseded_by_document_id) where superseded_by_document_id is not null;
