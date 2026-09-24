-- An order is worth keeping half written too.
--
-- 0103 allowed drafts of the two invoices, which were the longest forms and
-- so the ones where losing the work hurt most. An order is the document most
-- likely to be started and abandoned, though: it is typed while somebody is
-- still on the phone deciding, which is exactly the moment the entry gets
-- interrupted.
--
-- Nothing else changes. saveDocumentDraft, deleteDocumentDraft and both
-- queries never cared what type they were holding; this check was the only
-- thing that did.

alter table document_draft drop constraint if exists document_draft_doc_type_check;
alter table document_draft add constraint document_draft_doc_type_check
    check (doc_type in ('SALES_INVOICE', 'PURCHASE_INVOICE',
                        'SALES_ORDER',   'PURCHASE_ORDER'));
