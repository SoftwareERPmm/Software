-- Which order the goods that arrived were actually for.
--
-- A goods receipt closes a purchase order only when the record says the two
-- are connected: the receipt names the order, or a receipt line names an
-- order line. Two ordinary flows leave no such connection.
--
--   Receive goods with no PO chosen — the stock lands, the order is never
--   mentioned, and it sits at nothing received.
--
--   Bill first — the receipt names the invoice it clears. A document has one
--   source, and a purchase invoice may only name a goods receipt, so there is
--   no chain back to the order either.
--
-- Reproduced on 2026-09-09: PO for 10, all 10 received against the invoice,
-- invoice paid, and the order still reads "ordered 10, received 0" and turns
-- overdue on its own Needed-by date with the goods on the shelf.
--
-- The missing thing is a relationship, so this is one: a receipt line fulfils
-- an order line, for a stated quantity. It is deliberately not a column on
-- document_line — one receipt line can answer more than one order line, and
-- the invoice link already occupies source_line_id — and deliberately not
-- inferred from the item, because two orders for the same product would make
-- the guess close the wrong one as readily as the right one.
--
-- Append-only, like every other correction in this system. A link made in
-- error is undone by a reversing row, never by deleting the evidence that
-- somebody once claimed it.

create table if not exists fulfilment_link (
    id               uuid primary key default gen_random_uuid(),
    company_id       uuid not null references company(id),

    -- The goods: a line on a POSTED goods receipt or delivery.
    fulfilment_line_id uuid not null references document_line(id),
    -- The promise: a line on a POSTED purchase order or sales order.
    order_line_id      uuid not null references document_line(id),

    -- Signed, so a mistaken link is cancelled by its negative rather than
    -- erased. What counts as fulfilled is the sum, which is why nothing here
    -- needs updating, ever.
    qty              numeric(18,4) not null check (qty <> 0),

    -- Why someone said these goods answer this order, and when. "Who" waits
    -- for the user model this app has not built yet; the column exists so
    -- that when it does, the rows written before it are visibly unattributed
    -- rather than silently attributed to the wrong person.
    reason           text,
    linked_by        text,
    created_at       timestamptz not null default now(),

    -- Posted with the receipt itself, or added afterwards to repair the
    -- record. Worth distinguishing: the second is a correction and reads as
    -- one on the document's own history.
    source           text not null default 'MANUAL'
                     check (source in ('POSTING', 'MANUAL'))
);

create index if not exists fulfilment_link_fulfilment_idx
    on fulfilment_link (fulfilment_line_id);
create index if not exists fulfilment_link_order_idx
    on fulfilment_link (order_line_id);
create index if not exists fulfilment_link_company_idx
    on fulfilment_link (company_id);

comment on table fulfilment_link is
    'Goods that arrived, against the order line they answer. Written when a '
    'receipt or delivery is posted naming an order line, and when someone '
    'later links an existing one. Append-only: a wrong link is cancelled by '
    'a negative row, never deleted.';

create or replace function fn_fulfilment_link_immutable() returns trigger
language plpgsql as $$
begin
    raise exception
        'Fulfilment links are append-only. Cancel one with an opposite entry '
        'rather than changing or deleting it.';
end;
$$;

drop trigger if exists trg_fulfilment_link_immutable on fulfilment_link;
create trigger trg_fulfilment_link_immutable
    before update or delete on fulfilment_link
    for each row execute function fn_fulfilment_link_immutable();

-- ---------------------------------------------------------------------------
-- Goods no longer expected.
--
-- A different statement from the one above, and the difference matters. "Link
-- the receipt" says these goods arrived and answer this order. "Close the
-- remainder" says the rest is not coming. Closing alone would silence the
-- overdue warning while leaving the order's received quantity wrong, which is
-- how a report comes to look tidy and be false.

create table if not exists order_closure (
    id           uuid primary key default gen_random_uuid(),
    company_id   uuid not null references company(id),
    document_id  uuid not null references document(id),

    -- Required: an order abandoned for no stated reason is an order somebody
    -- will re-open the question of in six months.
    reason       text not null check (length(btrim(reason)) > 0),
    closed_by    text,
    closed_at    timestamptz not null default now(),

    -- Re-opened by a later row saying so, rather than by deletion.
    is_open      boolean not null default false
);

create index if not exists order_closure_document_idx
    on order_closure (document_id, closed_at desc);

comment on table order_closure is
    'An order whose outstanding quantity is no longer expected. The latest '
    'row for a document decides; re-opening appends is_open = true rather '
    'than removing the closure.';

-- What each order still expects, once links and closures are taken into
-- account. Ordered less fulfilled, per item so an over-delivery of one
-- product cannot hide a shortfall in another, and nothing at all once the
-- order has been closed.
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
-- fulfilment document that points at the order.
named as (
    select coalesce(ol.document_id, dd.source_document_id) as order_id,
           dl.item_id, sum(dl.base_qty) as qty
      from document_line dl
      join document dd on dd.id = dl.document_id
      left join document_line ol on ol.id = dl.source_line_id
     where dd.doc_type in ('GOODS_RECEIPT', 'DELIVERY')
       and dd.status = 'POSTED'
       and coalesce(ol.document_id, dd.source_document_id) is not null
     group by 1, dl.item_id
),
-- Linked afterwards, or posted alongside an invoice match.
linked as (
    select ol.document_id as order_id, ol.item_id, sum(fl.qty) as qty
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
    'Per order and item: ordered, fulfilled and still outstanding, counting '
    'goods named directly, goods linked afterwards, and nothing at all once '
    'the order is closed. One rule, so every screen that asks agrees.';
