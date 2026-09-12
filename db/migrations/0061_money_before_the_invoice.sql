-- Money that arrives before there is anything to apply it to.
--
-- A customer pays a deposit; a supplier wants paying up front. Today neither
-- can be recorded: postSettlement refuses a payment with nothing allocated
-- ("Enter an amount against at least one invoice"), so the only ways to get
-- the money into the books are to invent an invoice for it or to leave it out
-- until one exists. Both are worse than the problem.
--
-- Where the money sits is the whole of the design, and it is not the control
-- account. An unapplied receipt credited straight to receivables would make
-- the ledger and the subledger disagree the moment it was posted —
-- v_check_control_reconciliation ties the receivables balance to the sum of
-- open items, and an advance has no open item. It is also simply not what the
-- money is: a customer's deposit is something owed to them until the goods go
-- out, which is a liability, and money paid to a supplier in advance is
-- something owed to us, which is an asset.
--
--   receive an advance     Dr Cash              Cr Customer Advances
--   apply it to a bill     Dr Customer Advances Cr Accounts Receivable
--
--   pay one out            Dr Supplier Advances Cr Cash
--   apply it to a bill     Dr Accounts Payable  Cr Supplier Advances
--
-- Receivables and payables are untouched until the application, so the
-- reconciliation holds at every point, and applying moves the invoice's
-- outstanding through payment_allocation — the mechanism settlement already
-- uses, rather than a second one beside it.

-- ---------------------------------------------------------------------------
-- The two accounts, for companies that already exist. db/chart.mjs carries
-- them for the ones that do not yet.

insert into account (company_id, code, name, account_type, is_postable, is_active)
select c.id, a.code, a.name, a.account_type::account_type, true, true
  from company c
  cross join (values
      ('1070', 'Supplier Advances', 'ASSET'),
      ('2060', 'Customer Advances', 'LIABILITY')
  ) as a(code, name, account_type)
 where not exists (
       select 1 from account x where x.company_id = c.id and x.code = a.code)
;

comment on table account is
    'The chart. 1070 and 2060 hold money that moved before the invoice did: '
    'what we have paid a supplier in advance, and what a customer has paid us.';

-- ---------------------------------------------------------------------------
-- Two more system roles, so the engine resolves them the way it resolves
-- GR/IR rather than by hunting for a code.

alter table system_account drop constraint if exists system_account_role_check;
alter table system_account add constraint system_account_role_check
    check (role in (
        'GRIR_CLEARING', 'PURCHASE_PRICE_VARIANCE', 'PURCHASE_DISCOUNT_RECEIVED',
        'SALES_DISCOUNT_ALLOWED', 'STOCK_ADJUSTMENT', 'PROMOTION_EXPENSE',
        'FX_GAIN', 'FX_LOSS', 'ROUNDING_DIFFERENCE', 'OPENING_BALANCE_EQUITY',
        'RETAINED_EARNINGS', 'DELIVERY_INCOME',
        'CUSTOMER_ADVANCE', 'SUPPLIER_ADVANCE'
    ));

insert into system_account (company_id, role, account_id)
select c.id, r.role, a.id
  from company c
  join (values
      ('CUSTOMER_ADVANCE', '2060'),
      ('SUPPLIER_ADVANCE', '1070')
  ) as r(role, code) on true
  join account a on a.company_id = c.id and a.code = r.code
 where not exists (
       select 1 from system_account s where s.company_id = c.id and s.role = r.role)
;

-- ---------------------------------------------------------------------------
-- Applying an advance is a document, because every entry in this ledger is.

alter table document drop constraint if exists document_doc_type_check;
alter table document add constraint document_doc_type_check
    check (doc_type in (
        'PURCHASE_ORDER', 'GOODS_RECEIPT', 'PURCHASE_INVOICE', 'PURCHASE_RETURN',
        'SUPPLIER_PAYMENT', 'SALES_ORDER', 'DELIVERY', 'SALES_INVOICE',
        'SALES_RETURN', 'CUSTOMER_RECEIPT', 'STOCK_ADJUSTMENT', 'STOCK_TRANSFER',
        'CASH_VOUCHER', 'BANK_VOUCHER', 'JOURNAL_VOUCHER', 'CASH_TRANSFER',
        'OPENING_BALANCE', 'CONSIGNMENT_RECEIPT', 'CONSIGNMENT_SETTLEMENT',
        'ADVANCE_APPLICATION'
    ));

-- AA20260912001. Same shape as everything else, so it does not look foreign
-- in a list beside the documents it settles.
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
        when p_type = 'ADVANCE_APPLICATION' then 'AA'

        when p_type = 'PURCHASE_ORDER'      then 'PO'
        when p_type = 'SALES_ORDER'         then 'SO'
        when p_type = 'CASH_TRANSFER'       then 'CT'
        when p_type = 'OPENING_BALANCE'     then 'OB'
        else 'GEN'
    end;
$$;

-- ---------------------------------------------------------------------------
-- What each partner has on account.
--
-- Derived, never stored: a receipt's own total less whatever of it has since
-- been applied. A receipt raised against invoices in the ordinary way applies
-- all of itself at once and never appears here.

create or replace view v_partner_advance as
select
    d.company_id,
    d.partner_id,
    p.code  as partner_code,
    p.name  as partner_name,
    d.doc_type,
    d.id    as payment_id,
    d.doc_no,
    d.doc_date,
    d.gross_total                                as received,
    coalesce(al.applied, 0)                      as applied,
    d.gross_total - coalesce(al.applied, 0)      as available
  from document d
  join business_partner p on p.id = d.partner_id
  left join (
        select pa.payment_id, sum(pa.amount) as applied
          from payment_allocation pa
          join document inv on inv.id = pa.invoice_id
         where inv.status = 'POSTED'
         group by pa.payment_id
  ) al on al.payment_id = d.id
 where d.status = 'POSTED'
   and d.doc_type in ('CUSTOMER_RECEIPT', 'SUPPLIER_PAYMENT')
   and d.gross_total - coalesce(al.applied, 0) > 0.0001;

comment on view v_partner_advance is
    'Money received or paid that no invoice has claimed yet, per partner and '
    'per document. What is left of a receipt after everything it has settled.';
