-- 0023_document_immutable.sql
-- Posted documents become as immutable as the entries behind them.
--
-- journal_entry, journal_line and stock_movement have all refused edits and
-- deletions since the schema was written. document and document_line never
-- did, and the gap was not cosmetic: the subledgers are built from documents
-- while the control accounts are built from journal lines, so anything that
-- changes one without the other makes the two stop agreeing.
--
--   delete a posted sales invoice, and its journal entries survive - they are
--   protected. The receivable disappears from v_open_item, which reads
--   documents, while AR control still carries it. Aging and the trial balance
--   now tell different stories and nothing looks broken.
--
--   the same holds for a status change. v_open_item selects status = 'POSTED',
--   so flipping a posted invoice to CANCELLED hides the debt just as
--   effectively as deleting the row, and leaves the ledger untouched.
--
-- Found by scripts/test-evil.mjs, which deletes a posted document and checks
-- what survives.
--
-- What is deliberately still allowed: everything the posting engine itself
-- does. A document is inserted, its lines are written, its journal entry is
-- created, and only then is journal_entry_id set on the header - the same
-- statement that writes the final totals for a delivery. So the freeze starts
-- the moment a document has an entry, not the moment it is inserted, and
-- posting is unaffected. DRAFT documents stay fully editable and deletable;
-- they have no entry and no effect on any subledger.
--
-- TRUNCATE bypasses row triggers, so scripts/clear.mjs still works as before.

create or replace function fn_document_immutable() returns trigger
language plpgsql as $$
begin
    if (TG_OP = 'DELETE') then
        if OLD.status <> 'DRAFT' then
            raise exception
                'Document % is % and cannot be deleted. Post a reversal instead',
                OLD.doc_no, OLD.status;
        end if;
        return OLD;
    end if;

    -- No entry yet: this is the posting transaction still assembling the
    -- document, which is exactly when the header legitimately changes.
    if OLD.journal_entry_id is null then
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
            'fixed. Post a reversal or a correcting document instead',
            OLD.doc_no;
    end if;

    return NEW;
end;
$$;

create trigger trg_document_immutable
    before update or delete on document
    for each row execute function fn_document_immutable();

-- The lines matter for the same reason. Removing one leaves the journal entry
-- and the stock movements it produced with nothing to explain them.
create or replace function fn_document_line_immutable() returns trigger
language plpgsql as $$
declare
    v_entry uuid;
    v_no    text;
begin
    select journal_entry_id, doc_no into v_entry, v_no
      from document where id = coalesce(OLD.document_id, NEW.document_id);

    if v_entry is null then
        return coalesce(NEW, OLD);
    end if;

    raise exception
        'Document % is posted; its lines cannot be changed or removed. '
        'Post a reversal or a correcting document instead', v_no;
end;
$$;

create trigger trg_document_line_immutable
    before update or delete on document_line
    for each row execute function fn_document_line_immutable();
