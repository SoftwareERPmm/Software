-- 0029_consignment_sale.sql
-- Step 2 of consignment: selling it, and settling with the consignor.
--
-- The design, confirmed by the user after being shown the alternative
-- (silently blending owned and consigned stock under one FIFO draw):
--
--   Owned stock and consigned stock are separate pools. A normal sale draws
--   owned stock ONLY - the existing stock_lot/planFifoConsumption path is
--   completely untouched by this migration. A sale explicitly marked as
--   consignment-sourced draws consignment_lot instead, via its own FIFO
--   planner, and NEVER falls back to owned stock if there is not enough -
--   that would be exactly the silent mixing this design exists to prevent.
--
-- Settlement is recognized at the sales invoice, not the delivery (the
-- user's explicit choice from step 1), as a real PURCHASE_INVOICE document -
-- reusing that doc_type rather than inventing a third one, so the amount
-- owed shows up in AP aging and payables like any other bill, using
-- infrastructure that already exists rather than a parallel copy of it.
--
-- One consequence needed a guard amendment. A delivery whose lines are
-- ENTIRELY consignment-sourced has nothing owned to relieve - no Inventory,
-- no COGS, nothing to post - so it legitimately has zero journal lines. But
-- fn_document_posting_required (0014) requires DELIVERY to carry a journal
-- entry, unconditionally. That rule is right for every delivery that moves
-- owned stock and wrong for one that moves none, so it needs to become
-- content-aware for this one type rather than staying doc-type-blind - the
-- same technique step 1 used for CONSIGNMENT_RECEIPT, applied to a
-- document type most deliveries still need it to hold.

-- Which lines of a delivery were fulfilled from consigned stock rather than
-- owned. Needed by the guard below to tell "nothing to post" apart from
-- "something was forgotten to post". General on document_line rather than
-- delivery-specific, since the column means the same thing wherever it
-- might be set: default false everywhere.
alter table document_line add column is_consignment boolean not null default false;

create or replace function fn_document_posting_required() returns trigger
language plpgsql as $$
declare
    d document;
    v_all_consigned boolean;
begin
    select * into d from document where id = new.id;
    if not found then
        return null;
    end if;

    if d.status <> 'POSTED' or d.journal_entry_id is not null then
        return null;
    end if;

    if d.doc_type = 'DELIVERY' then
        -- A delivery moving only consigned stock has nothing owned to
        -- relieve, so a missing journal entry is correct rather than a sign
        -- something was skipped. Any owned or free-of-charge line still
        -- requires one, exactly as before - this only widens the exception
        -- for the specific case that has nothing to post at all.
        select coalesce(bool_and(dl.is_consignment), false) into v_all_consigned
          from document_line dl where dl.document_id = d.id;
        if v_all_consigned then
            return null;
        end if;
        raise exception
            'Document % (%) is posted but has no journal entry', d.doc_no, d.doc_type;
    end if;

    if d.doc_type in (
            'GOODS_RECEIPT', 'PURCHASE_INVOICE', 'PURCHASE_RETURN',
            'SUPPLIER_PAYMENT', 'SALES_INVOICE',
            'SALES_RETURN', 'CUSTOMER_RECEIPT', 'STOCK_ADJUSTMENT',
            'OPENING_BALANCE', 'CASH_VOUCHER', 'BANK_VOUCHER',
            'JOURNAL_VOUCHER', 'CASH_TRANSFER')
    then
        raise exception
            'Document % (%) is posted but has no journal entry',
            d.doc_no, d.doc_type;
    end if;

    return null;
end;
$$;

comment on column document_line.is_consignment is
    'True when this line was fulfilled from consigned stock rather than '
    'owned - drawn from consignment_lot via consignment_lot_consumption, '
    'never from stock_lot. Lets fn_document_posting_required tell a '
    'delivery with nothing owned to relieve apart from one missing its '
    'journal entry by mistake.';
