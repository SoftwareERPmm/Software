-- A credit limit that is not checked is a note, not a limit.
--
-- business_partner.credit_limit has been on the customer form since the
-- beginning and was read by two reports. The posting engine referenced it
-- nowhere: a customer with a 500,000 limit and 4,000,000 already owing could
-- be sold to all day. Worse than having no field at all — the screen looked
-- like a control, so nobody went looking for the one that was missing.
--
-- Going over a limit stays possible, because it is a commercial decision and
-- the person making it is standing at the counter. What changes is that it
-- must now be a decision: somebody confirms it, says why, and the document
-- carries that sentence for good. The same shape the negative-stock
-- confirmation already uses, because it is the same situation — a rule the
-- business can break knowingly but not by accident.

alter table document
  add column if not exists credit_override_reason text,
  add column if not exists credit_override_at     timestamptz,
  add column if not exists credit_override_by      uuid references app_user(id);

-- A reason and a timestamp arrive together or not at all. A document that
-- records an override without saying why records that somebody clicked.
alter table document drop constraint if exists document_credit_override_check;
alter table document add constraint document_credit_override_check check (
  (credit_override_at is null and credit_override_reason is null)
  or (credit_override_at is not null
      and length(btrim(coalesce(credit_override_reason, ''))) > 0)
);

comment on column business_partner.credit_limit is
  'What this customer may owe at once. NULL means no limit is set; 0 means no credit at all — cash only. The engine reads it on every credit sale.';

comment on column document.credit_override_reason is
  'Why this document was allowed to take the customer past their credit limit. Set only when it did.';

-- Who owes what against what they are allowed to owe.
--
-- Exposure is the money already outstanding plus goods that have left the
-- warehouse and have not been billed yet: stock that is gone is credit
-- extended whether or not an invoice exists for it. Orders not yet delivered
-- are deliberately excluded — a promise to deliver is not money at risk
-- until the goods move.
create or replace view v_customer_credit as
  select p.company_id,
         p.id                                  as partner_id,
         p.code                                as partner_code,
         p.name                                as partner_name,
         p.credit_limit,
         coalesce(oi.outstanding, 0)           as outstanding,
         coalesce(un.unbilled, 0)              as unbilled_deliveries,
         coalesce(oi.outstanding, 0) + coalesce(un.unbilled, 0) as exposure,
         case
           when p.credit_limit is null then null
           else p.credit_limit - (coalesce(oi.outstanding, 0) + coalesce(un.unbilled, 0))
         end                                   as available
    from business_partner p
    left join (
      select partner_id, sum(outstanding) as outstanding
        from v_open_item
       where doc_type = 'SALES_INVOICE'
       group by partner_id
    ) oi on oi.partner_id = p.id
    left join (
      select d.partner_id, sum(d.gross_total) as unbilled
        from document d
       where d.doc_type = 'DELIVERY' and d.status = 'POSTED'
         and not exists (
           select 1 from document si
            where si.doc_type = 'SALES_INVOICE' and si.status = 'POSTED'
              and (si.source_document_id = d.id or d.source_document_id = si.id)
         )
       group by d.partner_id
    ) un on un.partner_id = p.id
   where p.is_customer;
