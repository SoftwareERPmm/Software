-- A receipt counted twice is an order that looks finished.
--
-- v_order_outstanding tallied fulfilment two ways and added them:
--
--   named   — receipt or delivery lines that point at the order line
--   linked  — rows in fulfilment_link
--
--   fulfilled = LEAST(ordered, max(named.qty) + max(linked.qty))
--
-- The two were meant for different cases: goods received directly against an
-- order name it on the line, goods matched to an order afterwards get a link.
-- Nothing stopped a line being both, and when it was, its quantity was
-- counted once in each tally and added. One receipt of 20 read as 40.
--
-- On the pilot database that was PO-2627-000003: 40 ordered, 20 genuinely
-- received on GR-2627-000003, and an order reading fully received with
-- nothing outstanding. The supplier still owes 20 and the order had dropped
-- off the list of things to chase — which is the real cost. No ledger figure
-- was affected: stock, GR/IR and the payable all followed the true 20, and
-- this view feeds screens rather than postings.
--
-- Counted once per fulfilment line now, with the link authoritative where
-- one exists. A link can carry a partial quantity — one receipt line split
-- across two order lines — so where both registrations exist the link is the
-- more precise answer and the line's own quantity would overstate it.

create or replace view v_order_outstanding as
with ord as (
    select o.company_id,
           o.id        as order_id,
           o.doc_type,
           o.due_date,
           ol.id       as order_line_id,
           ol.item_id,
           ol.base_qty as ordered
      from document o
      join document_line ol on ol.document_id = o.id
     where o.doc_type in ('PURCHASE_ORDER', 'SALES_ORDER')
       and o.status = 'POSTED'
),
-- Every fulfilment of every order line, each line appearing once.
done as (
    -- Linked: authoritative, because it can be partial.
    select fn_current_document(ol.document_id) as order_id,
           ol.item_id,
           fl.fulfilment_line_id,
           fl.qty
      from fulfilment_link fl
      join document_line ol on ol.id = fl.order_line_id
      join document_line dl on dl.id = fl.fulfilment_line_id
      join document dd on dd.id = dl.document_id
     where dd.status = 'POSTED'

    union all

    -- Named on the line, and only where no link already speaks for it.
    select fn_current_document(coalesce(ol.document_id, dd.source_document_id)) as order_id,
           dl.item_id,
           dl.id,
           dl.base_qty
      from document_line dl
      join document dd on dd.id = dl.document_id
      left join document_line ol on ol.id = dl.source_line_id
     where dd.doc_type in ('GOODS_RECEIPT', 'DELIVERY')
       and dd.status = 'POSTED'
       and coalesce(ol.document_id, dd.source_document_id) is not null
       and not exists (
             select 1 from fulfilment_link fl2
              where fl2.fulfilment_line_id = dl.id
                and fl2.order_line_id is not distinct from dl.source_line_id)
),
fulfilled as (
    select order_id, item_id, sum(qty) as qty
      from done
     group by order_id, item_id
),
closed as (
    select distinct on (c.order_id) c.order_id, c.is_open
      from (
        select fn_current_document(oc.document_id) as order_id,
               oc.is_open, oc.closed_at
          from order_closure oc
      ) c
     order by c.order_id, c.closed_at desc
)
select ord.order_id,
       ord.company_id,
       ord.doc_type,
       ord.due_date,
       ord.item_id,
       sum(ord.ordered) as ordered,
       least(sum(ord.ordered), coalesce(max(fulfilled.qty), 0)) as fulfilled,
       case
         when coalesce(bool_and(coalesce(closed.is_open, true)), true)
           then greatest(sum(ord.ordered) - coalesce(max(fulfilled.qty), 0), 0)
         else 0
       end as outstanding,
       bool_or(coalesce(closed.order_id is not null and not closed.is_open, false)) as is_closed
  from ord
  left join fulfilled on fulfilled.order_id = ord.order_id
                     and fulfilled.item_id = ord.item_id
  left join closed on closed.order_id = ord.order_id
 group by ord.order_id, ord.company_id, ord.doc_type, ord.due_date, ord.item_id;
