-- A delivery keeps fulfilling the order it was raised against, across an edit.
--
-- Correcting an order posts a new version and retires the old one. Everything
-- already built on it still names the version it was raised against — which
-- is right, and is what makes the audit trail honest: the delivery really did
-- answer v1, and rewriting its link would be a lie about what happened.
--
-- But every screen that asks "how much of this order has shipped" looked at
-- the row the delivery names, found it cancelled, and reported nothing. So
-- correcting the price on a fully delivered order made it read as fully
-- outstanding, and overdue with it. Reproduced on 2026-09-10: order for 50,
-- all 50 shipped, price corrected — 0 delivered, 50 outstanding.
--
-- The fix is resolution rather than mutation. A relationship points at the
-- version that existed when it was made; anything counting fulfilment
-- follows the chain to the version that is live now.

create or replace function fn_current_document(p_id uuid) returns uuid
language sql stable as $$
    with recursive chain as (
        select d.id, d.superseded_by_document_id
          from document d where d.id = p_id
        union all
        select d.id, d.superseded_by_document_id
          from document d
          join chain c on d.id = c.superseded_by_document_id
    )
    select id from chain where superseded_by_document_id is null limit 1;
$$;

comment on function fn_current_document(uuid) is
    'The live version of whatever document this id belongs to. A document '
    'that has never been edited is its own answer; one that has been edited '
    'resolves through supersedes to the version standing now.';

-- Rebuilt only to resolve versions: every other line is 0051's, unchanged.
create or replace view v_order_outstanding as
with ord as (
    select o.id as order_id, o.company_id, o.doc_type, o.due_date,
           ol.id as order_line_id, ol.item_id, ol.base_qty as ordered
      from document o
      join document_line ol on ol.document_id = o.id
     where o.doc_type in ('PURCHASE_ORDER', 'SALES_ORDER')
       and o.status = 'POSTED'
),
-- Named directly: a fulfilment line that points at the order line, or a
-- fulfilment document that points at the order — in either case resolved to
-- whichever version of that order is live now.
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
closed as (
    select distinct on (document_id) document_id, is_open
      from order_closure
     order by document_id, closed_at desc
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
       bool_or(coalesce(closed.document_id is not null and not closed.is_open, false)) as is_closed
  from ord
  left join named  on named.order_id  = ord.order_id and named.item_id  = ord.item_id
  left join linked on linked.order_id = ord.order_id and linked.item_id = ord.item_id
  left join closed on closed.document_id = ord.order_id
 group by ord.order_id, ord.company_id, ord.doc_type, ord.due_date, ord.item_id;

comment on view v_order_outstanding is
    'Per order and item: ordered, fulfilled and still outstanding. Goods that '
    'answered an earlier version of an order still answer the version that '
    'replaced it — the link names the version it was made against, and this '
    'follows it forward.';
