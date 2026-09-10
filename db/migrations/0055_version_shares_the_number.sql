-- A number may repeat across versions. It may not repeat within one.
--
-- 0054 gave a document a version and said the number stays the same across an
-- edit. It could not, because a constraint from the beginning of the schema
-- says (company_id, doc_type, doc_no) is unique — so posting v2 of
-- DS20260910001 failed on the way in, before any of the versioning rules got
-- a say. The constraint was right when a number identified a document; now a
-- number identifies a document and the version says which one.
--
-- What replaces it has to be at least as strong. Three separate promises,
-- because they fail in three different ways:
--
--   a number and a version identify exactly one row — no two v2s
--   one version of a number is live at a time — no two current invoices
--   a version is replaced once — no competing replacements from two people
--     editing at the same moment
--
-- The last one matters more than it looks. Two sessions editing one invoice
-- would each void it and each post a replacement; the row lock in
-- amendDocument makes them queue, and the second then finds the original
-- already superseded and stops. These indexes are what makes that a
-- guarantee rather than a hope about lock ordering.

alter table document
    drop constraint if exists document_company_id_doc_type_doc_no_key;

-- The replacement for it: unique per version rather than per number. 0054
-- already added this without the type, which is the same promise given that
-- the type is encoded in the prefix — but stating it the way the old
-- constraint did keeps the two comparable.
create unique index if not exists document_no_version_uidx
    on document (company_id, doc_no, version) where doc_no is not null;

comment on index document_no_version_uidx is
    'A document number and a version identify one row. Replaces the original '
    'uniqueness on (company, type, number), which predates versions and made '
    'an edit impossible to post.';
