-- A bill can be reduced without the goods coming back
--
-- An invoice is wrong by 20,000 and nothing is being returned: the price was
-- agreed differently, a short delivery was billed in full, a discount was
-- settled after the fact. Until now the only instrument was amending the
-- invoice, which keeps its number and posts a new version — right for a
-- recording error, wrong once the customer is holding a printed document. It
-- makes their copy disagree with the books, and a tax office expects the
-- reduction to be its own dated paper rather than a reissued invoice.
--
-- So: a credit note on the sales side, a debit note on the purchase side.
-- Value only. Neither touches stock, which is the whole point — goods coming
-- back is a return, and that already exists.
--
--   CREDIT_NOTE   Dr Sales Return     / Cr Accounts Receivable
--   DEBIT_NOTE    Dr Accounts Payable / Cr Purchase Return
--
-- The invoice is never edited. What it owes is derived, and these join the
-- same subtraction a return already makes.

alter table document drop constraint if exists document_doc_type_check;
alter table document add constraint document_doc_type_check check (
    doc_type = any (array[
        'PURCHASE_ORDER','GOODS_RECEIPT','PURCHASE_INVOICE','PURCHASE_RETURN',
        'SUPPLIER_PAYMENT','SALES_ORDER','DELIVERY','SALES_INVOICE','SALES_RETURN',
        'CUSTOMER_RECEIPT','STOCK_ADJUSTMENT','STOCK_TRANSFER','CASH_VOUCHER',
        'BANK_VOUCHER','JOURNAL_VOUCHER','CASH_TRANSFER','OPENING_BALANCE',
        'CONSIGNMENT_RECEIPT','CONSIGNMENT_SETTLEMENT','ADVANCE_APPLICATION',
        'CREDIT_NOTE','DEBIT_NOTE'
    ])
);

-- CN and DN are free. DN reads as "delivery note" elsewhere in the trade, but
-- not here: a delivery in this system is SI, which is its own oddity and one
-- this migration is not going to make worse by inventing a third convention.
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
        else 'GEN'
    end;
$$;

-- PURCHASE_RETURN is not among the roles account_determination allows. It
-- never needed to be: a purchase return relieves GR/IR, because goods
-- physically go back. A debit note has no goods and no GR/IR to relieve, so
-- the role has to exist before a rule can name an account for it.
alter table account_determination drop constraint if exists account_determination_role_check;
alter table account_determination add constraint account_determination_role_check check (
    role = any (array[
        'INVENTORY','COGS','REVENUE','SALES_RETURN',
        'AR_CONTROL','AP_CONTROL','PURCHASE_RETURN'
    ])
);

-- A debit note credits Purchase Return, and no company had a rule for it: a
-- purchase return relieves GR/IR instead, because goods physically go back.
-- A debit note has no goods and no GR/IR to relieve, so the account the chart
-- has carried all along finally needs naming.
insert into account_determination (company_id, role, account_id)
select c.id, 'PURCHASE_RETURN', a.id
  from company c
  join account a on a.company_id = c.id and a.code = '5010'
 where not exists (
       select 1 from account_determination d
        where d.company_id = c.id and d.role = 'PURCHASE_RETURN'
          and d.item_group_id is null and d.partner_id is null and d.location_id is null);

-- What an invoice still owes already subtracts returns. A credit note is the
-- same subtraction without the goods, so it joins the same clause rather than
-- getting one of its own — two places that decide what is outstanding is how
-- two reports come to disagree.

create or replace view v_invoice_status as
SELECT d.company_id,
    d.id AS document_id,
    d.doc_type,
    d.doc_no,
    d.partner_id,
    p.code AS partner_code,
    p.name AS partner_name,
    d.posting_date,
    d.due_date,
    d.currency,
    d.gross_total,
    COALESCE(a.paid, 0::numeric) AS paid,
    d.gross_total - COALESCE(a.paid, 0::numeric) - COALESCE(r.returned, 0::numeric) AS outstanding,
        CASE
            WHEN COALESCE(a.paid, 0::numeric) = 0::numeric AND COALESCE(r.returned, 0::numeric) < d.gross_total THEN 'OPEN'::text
            WHEN COALESCE(a.paid, 0::numeric) >= (d.gross_total - COALESCE(r.returned, 0::numeric)) THEN 'PAID'::text
            ELSE 'PARTIALLY_PAID'::text
        END AS payment_status,
        CASE
            WHEN d.due_date IS NULL THEN NULL::integer
            ELSE CURRENT_DATE - d.due_date
        END AS days_overdue,
    COALESCE(r.returned, 0::numeric) AS returned
   FROM document d
     JOIN business_partner p ON p.id = d.partner_id
     LEFT JOIN ( SELECT pa.invoice_id,
            sum(pa.amount) AS paid
           FROM payment_allocation pa
             JOIN document pay ON pay.id = pa.payment_id
             LEFT JOIN document app ON app.id = pa.applied_by_document_id
          WHERE pay.status = 'POSTED'::text AND pay.reversed_by_document_id IS NULL AND (pa.applied_by_document_id IS NULL OR app.status = 'POSTED'::text)
          GROUP BY pa.invoice_id) a ON a.invoice_id = d.id
     LEFT JOIN ( SELECT fn_current_document(rr.source_document_id) AS invoice_id,
            sum(rr.gross_total) AS returned
           FROM document rr
          WHERE (rr.doc_type = ANY (ARRAY['SALES_RETURN'::text, 'PURCHASE_RETURN'::text, 'CREDIT_NOTE'::text, 'DEBIT_NOTE'::text])) AND rr.status = 'POSTED'::text AND rr.reversed_by_document_id IS NULL AND rr.reverses_document_id IS NULL AND rr.source_document_id IS NOT NULL
          GROUP BY (fn_current_document(rr.source_document_id))) r ON r.invoice_id = fn_current_document(d.id)
  WHERE d.status = 'POSTED'::text AND (d.doc_type = ANY (ARRAY['SALES_INVOICE'::text, 'PURCHASE_INVOICE'::text])) AND d.reverses_document_id IS NULL;

create or replace view v_open_item as
SELECT d.company_id,
    d.id AS document_id,
    d.doc_type,
    d.doc_no,
    d.partner_id,
    p.code AS partner_code,
    p.name AS partner_name,
    d.posting_date,
    d.due_date,
    d.currency,
    d.gross_total,
    COALESCE(al.allocated, 0::numeric) AS allocated,
    d.gross_total - COALESCE(al.allocated, 0::numeric) - COALESCE(r.returned, 0::numeric) AS outstanding,
        CASE
            WHEN d.due_date IS NULL THEN NULL::integer
            ELSE CURRENT_DATE - d.due_date
        END AS days_overdue,
        CASE
            WHEN d.due_date IS NULL THEN 'CURRENT'::text
            WHEN CURRENT_DATE <= d.due_date THEN 'CURRENT'::text
            WHEN (CURRENT_DATE - d.due_date) <= 30 THEN '1-30'::text
            WHEN (CURRENT_DATE - d.due_date) <= 60 THEN '31-60'::text
            WHEN (CURRENT_DATE - d.due_date) <= 90 THEN '61-90'::text
            ELSE '90+'::text
        END AS aging_bucket,
    COALESCE(r.returned, 0::numeric) AS returned
   FROM document d
     JOIN business_partner p ON p.id = d.partner_id
     LEFT JOIN ( SELECT pa.invoice_id,
            sum(pa.amount) AS allocated
           FROM payment_allocation pa
             JOIN document pay ON pay.id = pa.payment_id
             LEFT JOIN document app ON app.id = pa.applied_by_document_id
          WHERE pay.status = 'POSTED'::text AND pay.reversed_by_document_id IS NULL AND (pa.applied_by_document_id IS NULL OR app.status = 'POSTED'::text)
          GROUP BY pa.invoice_id) al ON al.invoice_id = d.id
     LEFT JOIN ( SELECT fn_current_document(rr.source_document_id) AS invoice_id,
            sum(rr.gross_total) AS returned
           FROM document rr
          WHERE (rr.doc_type = ANY (ARRAY['SALES_RETURN'::text, 'PURCHASE_RETURN'::text, 'CREDIT_NOTE'::text, 'DEBIT_NOTE'::text])) AND rr.status = 'POSTED'::text AND rr.reversed_by_document_id IS NULL AND rr.reverses_document_id IS NULL AND rr.source_document_id IS NOT NULL
          GROUP BY (fn_current_document(rr.source_document_id))) r ON r.invoice_id = fn_current_document(d.id)
  WHERE d.status = 'POSTED'::text AND (d.doc_type = ANY (ARRAY['SALES_INVOICE'::text, 'PURCHASE_INVOICE'::text])) AND d.reverses_document_id IS NULL AND (d.gross_total - COALESCE(al.allocated, 0::numeric) - COALESCE(r.returned, 0::numeric)) <> 0::numeric;
