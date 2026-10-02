-- Deliver an item that has never been received, with negative stock
-- confirmed, and the posting failed with "Journal entry JE… has no lines".
--
-- The goods leave, the shortfall is recorded, and the cost is nil: there
-- are no FIFO layers and no purchase anywhere to take a provisional cost
-- from, so every journal line nets to zero. journal_line forbids a zero
-- amount outright (journal_line_amount_check), so the entry was created
-- and then emptied, and fn_entry_has_lines refused it at commit.
--
-- A zero-value entry is not the answer; there is genuinely nothing to post
-- until a receipt arrives, and the negative-stock reconciliation already
-- carries the cost back to this delivery when it does. So the engine now
-- writes no entry, and this permits that for a delivery whose every line
-- is worth nothing — alongside the all-consigned case, which has the same
-- shape for the same reason: nothing owned to relieve.
--
-- Deliberately narrow. A delivery with any line carrying value still
-- requires its entry, so a genuinely missing posting is still caught.

create or replace function fn_document_posting_required() returns trigger
language plpgsql as $$
declare
    d document;
    v_all_consigned boolean;
    v_value numeric;
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
        -- something was skipped.
        select coalesce(bool_and(dl.is_consignment), false) into v_all_consigned
          from document_line dl where dl.document_id = d.id;
        if v_all_consigned then
            return null;
        end if;

        -- Nor has a delivery worth nothing. net_amount on a delivery line
        -- holds the cost the goods left at, free-of-charge lines included,
        -- so this is the whole value of the movement.
        select coalesce(sum(abs(dl.net_amount)), 0) into v_value
          from document_line dl where dl.document_id = d.id;
        if v_value = 0 then
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
