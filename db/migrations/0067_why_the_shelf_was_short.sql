-- 0067_why_the_shelf_was_short.sql
-- Why somebody said the goods were there when the books said they were not.
--
-- 0042 gave a document that goes into negative stock three things: a flag
-- saying it was confirmed, a timestamp saying when, and a column for who —
-- still null, waiting for authentication. What it never had was the reason.
--
-- And a reason matters more here than on most confirmations. Negative stock
-- is not an error to be waved past; it is a statement that the goods are
-- physically on the shelf and the paperwork that brought them in has not been
-- entered yet. That statement is either true or it is a loss nobody has
-- noticed, and the difference is in the reason. "Supplier delivery not yet
-- keyed in" and "not sure, it balanced last week" are the same click and
-- entirely different facts.
--
-- Structured rather than folded into the memo. Searching free text for a
-- reason means a delivery posts or refuses on whether somebody happened to
-- type something in a box meant for something else, and a memo can be about
-- anything. The engine needs to ask a question with an answer.

alter table document
    add column if not exists negative_stock_reason text;

comment on column document.negative_stock_reason is
    'Why the confirmer believes the goods are physically present when the '
    'books say they are not. Required by the posting engine whenever a '
    'document creates or deepens negative stock, alongside '
    'negative_stock_confirmed. Null on documents that never went short.';

-- The three travel together from here on. A confirmation with no reason is
-- the thing this migration exists to stop, and a reason on a document nobody
-- confirmed is a claim about an event that did not happen.
--
-- NOT VALID, deliberately.
--
-- Deliveries confirmed before this column existed have no reason and never
-- will. A validating constraint would refuse to be added at all where any
-- exist, and the ways round that are worse than the problem: inventing a
-- reason puts words in somebody's mouth, and copying whatever the memo
-- happened to say attributes a note about something else to a decision it
-- was not about. Both would make the record say something nobody said.
--
-- So the rule binds every insert and update from now on, and leaves what is
-- already written alone. Those rows stay exactly as they are — confirmed,
-- timestamped, and honestly without a reason — and the screens say so:
-- "Reason not recorded — legacy", never a blank that reads like an answer.
--
-- The constraint can be validated later, once a company has no such rows
-- left, with:
--
--   alter table document validate constraint document_negative_stock_reason_check;
--
-- That will refuse while any remain, which is the correct answer rather than
-- an obstacle: it means the history still holds confirmations nobody
-- explained, and that is a fact about the books, not about the schema.
-- NOT VALID alone is not enough, which is worth spelling out because it
-- looks as though it is. It exempts existing rows when the constraint is
-- added and nothing more: the moment one of those rows is updated, the new
-- version is checked like any other, and a confirmed delivery with no reason
-- fails. Measured, not assumed — touching an unrelated column on such a row
-- was refused, and so was recording a void reason on it, which is how a
-- correction to one of these documents would begin.
--
-- So the exemption is a fact about the row rather than a fact about when the
-- constraint was added. This column marks the confirmations that were made
-- before anybody was asked why, and the check accepts them for good.
alter table document
    add column if not exists negative_stock_reason_legacy boolean not null default false;

comment on column document.negative_stock_reason_legacy is
    'True on confirmations made before negative_stock_reason existed. Set '
    'once, by the migration that added the column, and never by the posting '
    'engine: a new confirmation cannot claim it and must carry a real '
    'reason. Shown as "Reason not recorded -- legacy".';

alter table document drop constraint if exists document_negative_stock_reason_check;
alter table document add constraint document_negative_stock_reason_check
    check (
      (negative_stock_confirmed
       and (length(btrim(coalesce(negative_stock_reason, ''))) > 0
            or negative_stock_reason_legacy))
      or (not negative_stock_confirmed
          and negative_stock_reason is null
          and not negative_stock_reason_legacy)
    ) not valid;

-- Exactly the rows that exist now and have no reason. Anything written after
-- this statement has one, or carries no confirmation at all.
update document
   set negative_stock_reason_legacy = true
 where negative_stock_confirmed
   and coalesce(btrim(negative_stock_reason), '') = '';

-- The backfill queues events for trg_document_posting_required, which is
-- DEFERRABLE INITIALLY DEFERRED, and Postgres will not alter a table with
-- trigger events outstanding. Firing them now clears the queue so the trigger
-- below can be created in this same transaction — which is the point: the
-- mark and the rule that protects it have to land together, or there is a
-- window between two migrations where anything could claim it.
--
-- It also switches every deferred constraint to immediate for the rest of
-- this transaction, which is why it comes last among the statements that
-- touch rows. Everything after it is DDL — a function, a trigger, a comment —
-- so nothing is left to be checked under the changed timing, and the setting
-- goes back to normal when the transaction ends.
set constraints all immediate;

-- And the exemption cannot be claimed after the fact. Without this the column
-- is a convention — anything writing to the table could set it and skip the
-- rule — rather than something only this migration could do.
create or replace function fn_negative_stock_legacy_is_historic() returns trigger
language plpgsql as $$
begin
    if tg_op = 'INSERT' and new.negative_stock_reason_legacy then
        raise exception
            'A new document cannot be marked as a legacy negative-stock '
            'confirmation. Give the confirmation a reason.';
    end if;
    if tg_op = 'UPDATE'
       and new.negative_stock_reason_legacy
       and not old.negative_stock_reason_legacy then
        raise exception
            'Document % cannot become a legacy negative-stock confirmation. '
            'That mark belongs to confirmations made before a reason was '
            'asked for.', old.doc_no;
    end if;
    return new;
end;
$$;

drop trigger if exists trg_negative_stock_legacy_is_historic on document;
create trigger trg_negative_stock_legacy_is_historic
    before insert or update on document
    for each row execute function fn_negative_stock_legacy_is_historic();

comment on constraint document_negative_stock_reason_check on document is
    'A confirmation carries its reason, and a reason belongs to a '
    'confirmation. Neither stands alone, unless the confirmation predates the '
    'question: those carry negative_stock_reason_legacy, set once by the '
    'migration and refused to anything else, and are shown as "Reason not '
    'recorded -- legacy" rather than given invented ones.';
