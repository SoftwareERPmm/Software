-- 0066_a_closure_follows_the_order_it_closed.sql
-- A closed order stays closed when it is corrected.
--
-- Closing writes a row against the document that was closed. Correcting an
-- order does not edit that document — it cancels it and posts the next
-- version under the same number, with a new id. So the closure went on
-- naming a version that is no longer the live one, and the version that is
-- had no closure against it at all: an order cancelled outright, then given a
-- corrected price, quietly started expecting sixty units again. Nobody
-- reopened it. Nobody was told. The Edit button is on the screen for exactly
-- the reason a price gets fixed, so this was not an exotic path.
--
-- Fixed here rather than by copying the closure onto each new version.
-- Copying leaves two rows that can disagree and a backfill question for every
-- order already corrected; resolving through the version chain has neither,
-- and fn_current_document already exists to do it — the same function
-- fulfilment links were taught to follow in 0056, for the same reason.
--
-- Reading is what changes, not writing. A closure still records the version
-- it was made against, which is the honest thing for it to say.

create or replace view v_order_outstanding as
with ord as (
    select o.company_id, o.id as order_id, o.doc_type, o.due_date,
           ol.id as order_line_id, ol.item_id, ol.base_qty as ordered
      from document o
      join document_line ol on ol.document_id = o.id
     where o.doc_type in ('PURCHASE_ORDER', 'SALES_ORDER')
       and o.status = 'POSTED'
),
named as (
    select fn_current_document(coalesce(ol.document_id, dd.source_document_id)) as order_id,
           dl.item_id, sum(dl.base_qty) as qty
      from document_line dl
      join document dd on dd.id = dl.document_id
      left join document_line ol on ol.id = dl.source_line_id
     where dd.doc_type in ('GOODS_RECEIPT', 'DELIVERY')
       and dd.status = 'POSTED'
       and coalesce(ol.document_id, dd.source_document_id) is not null
     group by 1, dl.item_id
),
linked as (
    select fn_current_document(ol.document_id) as order_id, ol.item_id, sum(fl.qty) as qty
      from fulfilment_link fl
      join document_line ol on ol.id = fl.order_line_id
      join document_line dl on dl.id = fl.fulfilment_line_id
      join document dd on dd.id = dl.document_id
     where dd.status = 'POSTED'
     group by 1, ol.item_id
),
-- The only change: a closure is resolved to whichever version of that order
-- is live now, so the latest word on any version is the latest word on all of
-- them. Ordered by closed_at across the whole chain, so a reopen written
-- against v1 and a closure written against v2 still resolve in the order they
-- actually happened.
closed as (
    select distinct on (order_id) order_id, is_open
      from (
        select fn_current_document(oc.document_id) as order_id, oc.is_open, oc.closed_at
          from order_closure oc
      ) c
     order by order_id, closed_at desc
)
select ord.order_id,
       ord.company_id,
       ord.doc_type,
       ord.due_date,
       ord.item_id,
       sum(ord.ordered) as ordered,
       least(sum(ord.ordered),
             coalesce(max(named.qty), 0) + coalesce(max(linked.qty), 0)) as fulfilled,
       case when coalesce(bool_and(coalesce(closed.is_open, true)), true) then
              greatest(sum(ord.ordered)
                       - coalesce(max(named.qty), 0)
                       - coalesce(max(linked.qty), 0), 0)
            else 0
       end as outstanding,
       bool_or(coalesce(closed.order_id is not null and not closed.is_open, false)) as is_closed
  from ord
  left join named  on named.order_id  = ord.order_id and named.item_id  = ord.item_id
  left join linked on linked.order_id = ord.order_id and linked.item_id = ord.item_id
  left join closed on closed.order_id = ord.order_id
 group by ord.order_id, ord.company_id, ord.doc_type, ord.due_date, ord.item_id;

comment on view v_order_outstanding is
    'Per order and item: ordered, fulfilled and still outstanding. Goods that '
    'answered an earlier version of an order still answer the version that '
    'replaced it, and a closure made against an earlier version still closes '
    'the version that replaced it -- both follow the chain forward rather '
    'than matching one exact id.';
