-- Money taken in advance can be given back.
--
-- An advance had three states (taken, partly applied, fully applied) and no
-- way out of them except an invoice. A customer who paid 1,000 up front and
-- then cancelled the order had 1,000 sitting in Customer Advances for ever,
-- because the only thing that could reduce it was a bill they were never
-- going to get. The same on the other side: a supplier returning a deposit
-- had nowhere to put it.
--
-- A refund is its own document, pointing at the advance it gives back:
--
--   customer   Dr Customer Advances   Cr Cash or Bank
--   supplier   Dr Cash or Bank        Cr Supplier Advances
--
-- It reduces what is available on the advance exactly as an application
-- does, so a refunded advance cannot then be applied and an applied one
-- cannot then be refunded. Voiding the refund puts the money back on account.

alter table document drop constraint if exists document_doc_type_check;
alter table document add constraint document_doc_type_check check (
  doc_type = any (array[
    'PURCHASE_ORDER','GOODS_RECEIPT','PURCHASE_INVOICE','PURCHASE_RETURN',
    'SUPPLIER_PAYMENT','SALES_ORDER','DELIVERY','SALES_INVOICE','SALES_RETURN',
    'CUSTOMER_RECEIPT','STOCK_ADJUSTMENT','STOCK_TRANSFER','CASH_VOUCHER',
    'BANK_VOUCHER','JOURNAL_VOUCHER','CASH_TRANSFER','OPENING_BALANCE',
    'CONSIGNMENT_RECEIPT','CONSIGNMENT_SETTLEMENT','ADVANCE_APPLICATION',
    'CREDIT_NOTE','DEBIT_NOTE','YEAR_END_CLOSE','ADVANCE_REFUND'
  ])
);

CREATE OR REPLACE FUNCTION public.fn_document_prefix(p_type text, p_direction text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
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
        -- Its own prefix rather than the left(p_type, 3) fallback, which
        -- would give ADV, the prefix an advance application already falls
        -- back to, and two document types sharing a prefix share a number.
        when p_type = 'ADVANCE_REFUND'      then 'RF'
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
$function$;

CREATE OR REPLACE FUNCTION public.fn_document_posting_required()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
            'JOURNAL_VOUCHER', 'CASH_TRANSFER', 'ADVANCE_REFUND')
    then
        raise exception
            'Document % (%) is posted but has no journal entry',
            d.doc_no, d.doc_type;
    end if;

    return null;
end;
$function$;

-- What is left on an advance is what came in, less what invoices claimed,
-- less what was handed back. Only posted refunds count, so voiding one puts
-- the money back on account without a special case.
drop view if exists v_partner_advance;
create view v_partner_advance as
select
    d.company_id,
    d.partner_id,
    p.code  as partner_code,
    p.name  as partner_name,
    d.doc_type,
    d.id    as payment_id,
    d.doc_no,
    d.doc_date,
    d.location_id,
    d.gross_total                                                    as received,
    coalesce(al.applied, 0)                                          as applied,
    coalesce(rf.refunded, 0)                                         as refunded,
    d.gross_total - coalesce(al.applied, 0) - coalesce(rf.refunded, 0) as available
  from document d
  join business_partner p on p.id = d.partner_id
  left join (
        select pa.payment_id, sum(pa.amount) as applied
          from payment_allocation pa
          join document inv on inv.id = pa.invoice_id
          left join document app on app.id = pa.applied_by_document_id
         where inv.status = 'POSTED'
           and (pa.applied_by_document_id is null or app.status = 'POSTED')
         group by pa.payment_id
  ) al on al.payment_id = d.id
  left join (
        select r.source_document_id as payment_id, sum(r.gross_total) as refunded
          from document r
         where r.doc_type = 'ADVANCE_REFUND' and r.status = 'POSTED'
         group by r.source_document_id
  ) rf on rf.payment_id = d.id
 where d.status = 'POSTED'
   and d.doc_type in ('CUSTOMER_RECEIPT', 'SUPPLIER_PAYMENT')
   and d.gross_total - coalesce(al.applied, 0) - coalesce(rf.refunded, 0) > 0.0001;

comment on view v_partner_advance is
    'Money received or paid that no invoice has claimed and that has not been '
    'handed back, per partner and per document, and the branch that took it.';
