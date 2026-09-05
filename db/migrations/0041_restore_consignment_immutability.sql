-- Put back the consignment rule 0037 dropped.
--
-- 0037 rewrote fn_document_immutable to allow the one transition a void
-- needs. It was written from the 0023 text, and 0028 had since added a branch
-- to that function which the rewrite silently lost:
--
--   if OLD.doc_type <> 'CONSIGNMENT_RECEIPT' and OLD.journal_entry_id is null
--
-- Every other document type has a journal entry moments after it is inserted,
-- so "no entry yet" is the brief window in which the posting transaction is
-- still assembling it. A consignment receipt records custody rather than
-- value and never gets one at all, so for that type the window never closes —
-- and without 0028's branch, a posted consignment receipt was editable and
-- deletable for ever. That is the bug 0028 was written to fix, reintroduced.
--
-- Caught by scripts/test-consignment.mjs: "the receipt's total cannot be
-- edited after posting". Worth recording how, because the lesson is not about
-- consignment — rewriting a function from an older copy of itself drops
-- whatever was added in between, and nothing about the diff makes that
-- visible.

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

    -- 0028. A consignment receipt never carries a journal entry, so for that
    -- type alone "no journal entry yet" is not an assembling window — it is
    -- permanent, and POSTED must mean frozen immediately.
    if OLD.doc_type <> 'CONSIGNMENT_RECEIPT' and OLD.journal_entry_id is null then
        return NEW;
    end if;

    -- 0037. The one permitted change to a posted document: it becomes
    -- REVERSED, and only together with the reversal that cancels it. Nothing
    -- else about it may move in the same statement — a void is not an
    -- opportunity to correct the total on the way past.
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
