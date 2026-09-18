-- A voided document can be entered again, once
--
-- Voiding is final: 0037 permits POSTED -> REVERSED and nothing after it, and
-- 0023 refuses to let a posted entry change at all. That is deliberate — a
-- ledger nobody can quietly rewrite is the whole point — and it means there is
-- no such thing as un-voiding. The reversal is a posted document of its own;
-- taking it back would mean erasing an entry, and then last month's printed
-- report no longer reproduces.
--
-- What somebody actually wants when they ask to undo a void is the document
-- back, not the entry. So: enter it again. A new document, a new number, its
-- lines copied from the one that was voided, posted like anything else — and
-- a pointer home, so the two are readable as one story rather than as a
-- mistake and an unexplained duplicate.
--
-- The pointer sits on the new document rather than the old one, which is what
-- keeps this out of the immutability trigger's way: nothing about the voided
-- document changes. "Re-entered as X" is read backwards, by looking for the
-- document that points here.
--
-- Once, and the database is what enforces it. An application check would be
-- two clicks away from posting the same sale twice — two people on the same
-- voided invoice, or one person and a slow network. A unique index cannot be
-- raced.

alter table document
  add column if not exists restored_from_document_id uuid references document(id);

comment on column document.restored_from_document_id is
    'The voided document this one was entered again from. Its lines were '
    'copied; nothing else is shared — this document has its own number, its '
    'own date and its own journal entry. Null for everything entered from '
    'scratch, which is almost everything.';

-- One re-entry per voided document. Partial, so the column stays null for the
-- ordinary case without every such row colliding with every other.
create unique index if not exists document_restored_once_idx
    on document (restored_from_document_id)
 where restored_from_document_id is not null;

-- Read the other way: given a voided document, what replaced it.
create index if not exists document_restored_from_idx
    on document (company_id, restored_from_document_id)
 where restored_from_document_id is not null;
