-- Work you have not finished is still worth keeping.
--
-- A sales voucher is the longest form in the app — customer, warehouse,
-- payment terms, a dozen lines each with a unit, a price level, a discount
-- and a tax code. Until now it was post or lose it: navigate away with it
-- half filled and there was nothing to come back to.
--
-- Why not a DRAFT row in `document`, which the schema plainly anticipates —
-- doc_no is nullable, status defaults to 'DRAFT', and document_check already
-- says a number is only required once a row is POSTED. Because the rest of
-- the app was written when nothing could be in that state. queries.ts reads
-- `from document` in 123 places and names status = 'POSTED' in 66 of them,
-- and about twenty views select from it besides. Roughly half of those would
-- have to be read and reasoned about to be sure an unfinished invoice does
-- not quietly turn up in a total, and missing one would not raise an error —
-- it would just make a figure wrong. getInvoiceList already unions drafts in
-- and says in its own comment that this half "returns nothing in practice",
-- so the intent survives; it simply is not worth the blast radius yet.
--
-- So a draft lives beside the ledger rather than inside it, holding the form
-- as the form submits it. That also resumes more faithfully: the payload
-- keeps choices document_line has no column for, such as whether a line
-- draws on owned or consigned stock, which a round trip through the ledger
-- tables would silently drop back to owned.
--
-- Nothing here touches the ledger. A draft has no journal entry, no stock
-- movement, no number, and no effect on any report. It becomes real the
-- moment it posts, through the same posting path as any other invoice, and
-- is deleted in that same transaction.

create table if not exists document_draft (
    id          uuid primary key default gen_random_uuid(),
    company_id  uuid not null references company(id) on delete cascade,
    doc_type    text not null,

    -- Denormalised so a list of drafts costs one query and no JSON parsing.
    -- These are a description of the payload, never the source of truth: the
    -- payload is, and posting reads only that.
    partner_id  uuid references business_partner(id),
    doc_date    date,
    total       numeric(18,4) not null default 0,
    line_count  integer not null default 0,

    -- The form, exactly as it submitted. Deliberately not a set of columns:
    -- the voucher grows fields often, and a draft that silently dropped the
    -- newest one would be worse than no draft at all.
    payload     jsonb not null,

    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),

    constraint document_draft_doc_type_check
        check (doc_type in ('SALES_INVOICE', 'PURCHASE_INVOICE'))
);

create index if not exists document_draft_company_type_idx
    on document_draft (company_id, doc_type, updated_at desc);

comment on table document_draft is
    'An unfinished document, held as the form that would post it. No number, '
    'no journal entry, no ledger effect — see the migration for why this is '
    'not a DRAFT row in `document`.';

comment on column document_draft.payload is
    'The submitted form. The only source of truth for what the draft holds; '
    'the columns beside it exist so a list does not have to parse it.';
