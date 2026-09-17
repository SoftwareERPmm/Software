-- An application that was undone stops settling the invoice
--
-- 0062 gave an advance application its own undo: the allocation it writes
-- carries applied_by_document_id, and the views stopped counting an
-- allocation whose application had been voided. That is what puts an invoice
-- back to owing what it owes when somebody takes the advance off it again.
--
-- 0070 rebuilt v_invoice_status and v_open_item to net returns off and to
-- ignore reversed payments, and in restating them dropped 0062's clause. The
-- payment filter it added is right and stays; it simply answers a different
-- question. An advance application does not reverse the receipt — the money
-- is still the receipt's, and the application is only the act of pointing it
-- at a bill — so voiding the application leaves pay.status POSTED and the
-- allocation kept counting. The invoice stayed settled by an application that
-- no longer exists.
--
-- Caught by test-advances, which has asserted this since 0062: "voiding the
-- application puts the invoice back to 12,000" was reading 4,000.
--
-- Both conditions now, because they are both true: money counts while the
-- payment stands AND while the application that pointed it here stands.

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
          WHERE pay.status = 'POSTED'::text AND pay.reversed_by_document_id IS NULL
            AND (pa.applied_by_document_id IS NULL OR app.status = 'POSTED'::text)
          GROUP BY pa.invoice_id) a ON a.invoice_id = d.id
     LEFT JOIN ( SELECT fn_current_document(rr.source_document_id) AS invoice_id,
            sum(rr.gross_total) AS returned
           FROM document rr
          WHERE (rr.doc_type = ANY (ARRAY['SALES_RETURN'::text, 'PURCHASE_RETURN'::text])) AND rr.status = 'POSTED'::text AND rr.reversed_by_document_id IS NULL AND rr.reverses_document_id IS NULL AND rr.source_document_id IS NOT NULL
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
          WHERE pay.status = 'POSTED'::text AND pay.reversed_by_document_id IS NULL
            AND (pa.applied_by_document_id IS NULL OR app.status = 'POSTED'::text)
          GROUP BY pa.invoice_id) al ON al.invoice_id = d.id
     LEFT JOIN ( SELECT fn_current_document(rr.source_document_id) AS invoice_id,
            sum(rr.gross_total) AS returned
           FROM document rr
          WHERE (rr.doc_type = ANY (ARRAY['SALES_RETURN'::text, 'PURCHASE_RETURN'::text])) AND rr.status = 'POSTED'::text AND rr.reversed_by_document_id IS NULL AND rr.reverses_document_id IS NULL AND rr.source_document_id IS NOT NULL
          GROUP BY (fn_current_document(rr.source_document_id))) r ON r.invoice_id = fn_current_document(d.id)
  WHERE d.status = 'POSTED'::text AND (d.doc_type = ANY (ARRAY['SALES_INVOICE'::text, 'PURCHASE_INVOICE'::text])) AND d.reverses_document_id IS NULL AND (d.gross_total - COALESCE(al.allocated, 0::numeric) - COALESCE(r.returned, 0::numeric)) <> 0::numeric;
