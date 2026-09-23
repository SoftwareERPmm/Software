-- A journal entry gets its own prefix back.
--
-- 0035 gave JOURNAL the prefix JE and said why, in the migration itself:
--
--     JE keeps them distinct from the J of a journal voucher, which would
--     otherwise share a prefix and hand out the same number twice.
--
-- 0061 rebuilt fn_document_prefix to add the money-before-the-invoice types
-- and the JOURNAL case did not survive the rewrite. Every journal entry
-- since has fallen through to `else 'GEN'` — the catch-all meant for a type
-- nobody has listed yet.
--
-- Nothing broke loudly, which is why it lasted: GEN does not collide with J,
-- so the specific accident 0035 feared did not happen. What it does instead
-- is put journal entries in the same counter as any future unlisted type,
-- because number_series is keyed by prefix. The next document type somebody
-- adds without touching this function would start issuing numbers from the
-- middle of the journal's own sequence.
--
-- Found by scripts/test-year-rollover.mjs, which has asserted the JE prefix
-- since 0035 and had been failing ever since.
--
-- Old entries keep the numbers they were issued. GEN20260916001 stays
-- GEN20260916001 — it is what the journal, the ledger and any printout
-- already say, and renumbering a posted entry to tidy a prefix is the kind
-- of edit this system refuses everywhere else. Only new entries get JE.
--
-- Safe against the three JE entries already on file: their number_series
-- rows survived 0061 with the right next_value, so an entry back-dated to a
-- day that already has one continues that day's count rather than repeating
-- its first number.

create or replace function fn_document_prefix(p_type text, p_direction text)
returns text language sql immutable as $$
    select case
        when p_type = 'CASH_VOUCHER' and p_direction = 'OUT' then 'P'
        when p_type = 'CASH_VOUCHER'                         then 'R'
        when p_type = 'BANK_VOUCHER' and p_direction = 'OUT' then 'BP'
        when p_type = 'BANK_VOUCHER'                         then 'BR'

        when p_type = 'CUSTOMER_RECEIPT'    then 'CR'
        when p_type = 'SUPPLIER_PAYMENT'    then 'CP'
        when p_type = 'JOURNAL_VOUCHER'     then 'J'
        when p_type = 'SALES_INVOICE'       then 'DS'
        when p_type = 'SALES_RETURN'        then 'SR'
        when p_type = 'PURCHASE_INVOICE'    then 'DP'
        when p_type = 'PURCHASE_RETURN'     then 'PR'
        when p_type = 'STOCK_TRANSFER'      then 'ST'
        when p_type = 'GOODS_RECEIPT'       then 'STR'
        when p_type = 'DELIVERY'            then 'SI'
        when p_type = 'STOCK_ADJUSTMENT'    then 'SAJ'
        when p_type = 'CREDIT_NOTE'         then 'CN'
        when p_type = 'DEBIT_NOTE'          then 'DN'

        when p_type = 'PURCHASE_ORDER'      then 'PO'
        when p_type = 'SALES_ORDER'         then 'SO'
        when p_type = 'CASH_TRANSFER'       then 'CT'
        when p_type = 'OPENING_BALANCE'     then 'OB'
        when p_type = 'CONSIGNMENT_RECEIPT' then 'CNR'
        when p_type = 'DELIVERY_TRIP'       then 'TRP'
        when p_type = 'BANK_STATEMENT'      then 'BST'
        when p_type = 'YEAR_END_CLOSE'      then 'YEC'

        -- Back, with the reason restated so the next rewrite of this
        -- function keeps it: a journal entry is not a journal voucher, and
        -- GEN is for a type nobody has named yet, not for the one thing
        -- every posting in the system creates.
        when p_type = 'JOURNAL'             then 'JE'
        else 'GEN'
    end;
$$;
