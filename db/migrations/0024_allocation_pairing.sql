-- 0024_allocation_pairing.sql
-- A payment may only settle the kind of invoice it is capable of settling.
--
-- payment_allocation.invoice_id is a foreign key to document, and document
-- holds every kind of document there is. Nothing said the row on the other
-- end had to be an invoice at all, let alone the right sort of one, so a
-- supplier payment could be allocated to a sales invoice and it posted
-- cleanly:
--
--   AR control kept the 100,000 the customer still owed
--   AP control took a 100,000 debit for a supplier who was never involved
--   v_open_item reported the invoice settled, because it reads allocations
--   and the cash left the business to collect a debt owed to it
--
-- The entry balanced, every guard passed, and all four figures were wrong.
-- The cause is that the control account is resolved from the payment's own
-- type while the outstanding balance is resolved from the invoice's, so
-- mismatching the pair puts the subledger and the ledger on opposite sides
-- of the same transaction.
--
-- Enforced here as well as in lib/posting.ts because the application is not
-- the only writer — scripts/test-evil.mjs demonstrates inserting straight
-- into payment_allocation, and fn_allocation_within_invoice already exists
-- precisely because the over-application rule had to hold there too.
--
-- Only two pairings exist, and both are what the posting engine produces:
--   CUSTOMER_RECEIPT  settles  SALES_INVOICE
--   SUPPLIER_PAYMENT  settles  PURCHASE_INVOICE

create or replace function fn_allocation_pairing() returns trigger
language plpgsql as $$
declare
    v_pay_type text;
    v_pay_no   text;
    v_inv_type text;
    v_inv_no   text;
    v_inv_stat text;
    v_expected text;
begin
    select doc_type, doc_no into v_pay_type, v_pay_no
      from document where id = new.payment_id;
    select doc_type, doc_no, status into v_inv_type, v_inv_no, v_inv_stat
      from document where id = new.invoice_id;

    v_expected := case v_pay_type
        when 'CUSTOMER_RECEIPT' then 'SALES_INVOICE'
        when 'SUPPLIER_PAYMENT' then 'PURCHASE_INVOICE'
        else null
    end;

    if v_expected is null then
        raise exception
            'Document % is a % and cannot settle anything',
            v_pay_no, lower(replace(v_pay_type, '_', ' '));
    end if;

    if v_inv_type <> v_expected then
        raise exception
            'A % cannot settle %, which is a %. It settles a %',
            lower(replace(v_pay_type, '_', ' ')), v_inv_no,
            lower(replace(v_inv_type, '_', ' ')),
            lower(replace(v_expected, '_', ' '));
    end if;

    if v_inv_stat <> 'POSTED' then
        raise exception 'Invoice % is % and cannot be settled', v_inv_no, v_inv_stat;
    end if;

    return new;
end;
$$;

create trigger trg_allocation_pairing
    before insert or update on payment_allocation
    for each row execute function fn_allocation_pairing();

comment on function fn_allocation_pairing is
    'A payment settles only the invoice type it has a control account for. '
    'Mismatching the pair leaves the subledger and the general ledger on '
    'opposite sides of the same transaction, in balance and both wrong.';
