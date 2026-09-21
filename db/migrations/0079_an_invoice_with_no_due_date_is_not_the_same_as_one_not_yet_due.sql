-- An invoice with no due date is not the same as one not yet due
--
-- Both landed in CURRENT, the green band, because neither has missed a
-- deadline. But one has a deadline it has not reached, and the other has no
-- deadline at all — and the second is the one worth looking at. A bill from
-- eight months ago that nobody agreed terms on sat in the healthy band
-- looking settled, indistinguishable from a bill due next Tuesday.
--
-- So it gets its own bucket. Not a worse one: NO_DUE_DATE is not overdue,
-- and nothing may treat it as though it were. It is unknown, which is a
-- different thing and the reason to show it — somebody has to go and find
-- out what was agreed.
--
-- The split lives here rather than in the screen that wanted it. Two places
-- deciding which band an invoice belongs to is how two reports come to
-- disagree, and the aging screen, the dashboard and the receivables list all
-- read this column.

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
            WHEN d.due_date IS NULL THEN 'NO_DUE_DATE'::text
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
