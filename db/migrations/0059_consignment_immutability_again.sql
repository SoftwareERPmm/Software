-- The same rule, dropped the same way, for the third time.
--
-- 0028 added a branch to fn_document_immutable: a consignment receipt never
-- gets a journal entry, so for that type alone "no entry yet" is not the brief
-- window in which a posting transaction is still assembling a document — it is
-- permanent, and POSTED has to mean frozen immediately.
--
-- 0037 rewrote the function from 0023's text and lost that branch. 0041 put it
-- back, and said in its own comment exactly what had gone wrong: rewriting a
-- function from an older copy of itself drops whatever was added in between,
-- and nothing about the diff makes that visible.
--
-- 0054 then rewrote the function again, to allow the supersede transition an
-- edit needs, and lost the branch again — from 0037's text this time, which
-- was the copy that never had it. A posted consignment receipt has been
-- editable and deletable since. Caught by the same test that caught it in
-- 0041: "the receipt's total cannot be edited after posting".
--
-- The lesson clearly does not survive being written in a comment, so this is
-- the last rewrite: the branch is stated first, before anything else, where
-- losing it means losing the first line of the function rather than a
-- condition buried in the middle of one.

create or replace function fn_document_immutable() returns trigger
language plpgsql as $$
declare
    -- 0028, 0041, 0059. Stated once, at the top, so every path below reads it
    -- rather than each restating the condition — and so a future rewrite that
    -- drops it produces a compile error rather than a silent hole.
    assembling boolean := OLD.journal_entry_id is null
                          and OLD.doc_type <> 'CONSIGNMENT_RECEIPT';
begin
    if (TG_OP = 'DELETE') then
        if OLD.status <> 'DRAFT' then
            raise exception
                'Document % is % and cannot be deleted. Void it instead — that '
                'posts a reversal and keeps both entries', OLD.doc_no, OLD.status;
        end if;
        return OLD;
    end if;

    -- Still being written: the posting transaction has not attached an entry
    -- yet, which is exactly when the header legitimately changes. An order
    -- never acquires one either, which is why an order can be superseded
    -- without a reversal — there is no entry to reverse. A consignment
    -- receipt is deliberately excluded: it never gets an entry at all, so for
    -- that type this window would never close.
    if assembling then
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

    -- 0054. A reversed version learns which version replaced it. Only that
    -- column moves, and only from empty — a document is superseded once.
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
