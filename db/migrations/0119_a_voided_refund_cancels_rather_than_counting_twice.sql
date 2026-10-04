-- A voided refund must cancel, not count twice.
--
-- Voiding a refund posts a mirror document of the same type, POSTED, with the
-- amount negated, and marks the original REVERSED. v_partner_advance counted
-- posted refunds per advance, so it survived only because the mirror happens
-- to carry no source_document_id. Were void ever to copy the source for
-- traceability, the mirror would be counted as a negative refund on top of
-- the original being dropped, and a cancelled refund would put the money back
-- on account twice.
--
-- The advance ledger already excludes the mirror a voided receipt leaves
-- behind, for the same reason. Refunds now follow the same rule.

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
           -- Not the mirror a void posts. It is a refund document too, and
           -- POSTED, carrying the negative; counting it would hand the
           -- money back a second time instead of cancelling the first.
           and r.reverses_document_id is null
         group by r.source_document_id
  ) rf on rf.payment_id = d.id
 where d.status = 'POSTED'
   and d.doc_type in ('CUSTOMER_RECEIPT', 'SUPPLIER_PAYMENT')
   and d.gross_total - coalesce(al.applied, 0) - coalesce(rf.refunded, 0) > 0.0001;

comment on view v_partner_advance is
    'Money received or paid that no invoice has claimed and that has not been '
    'handed back, per partner and per document, and the branch that took it.';
