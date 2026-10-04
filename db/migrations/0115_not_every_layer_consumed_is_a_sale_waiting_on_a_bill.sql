-- v_delivery_cost_unclaimed, as 0114 defined it, counted every consumed
-- layer in the company.
--
-- The view exists for one invariant, the one that will say whether the
-- change in docs/03-decisions.md D8 is working:
--
--     1090 balance = delivered FIFO cost not yet claimed by invoices
--
-- It cannot say that while it also counts cost that will never reach 1090.
-- Receive 100 at 100, give 5 away and deliver 10 against a sale, and the
-- view reported 1,500: the 1,000 that is genuinely waiting on an invoice,
-- plus 500 of promotion expense that was settled the moment the goods left
-- and is waiting on nothing.
--
-- Giveaways are not the only leak. recordFifoConsumption is called by stock
-- adjustments, stock transfers and purchase returns as well as deliveries,
-- and a layer consumed by a write-off is cost of a loss, not a sale nobody
-- has billed.
--
-- So the view is scoped to exactly what will land in 1090: a posted
-- delivery, a line that is not free of charge, and goods we owned. Scoped
-- by document and line rather than by which expense account the cost went
-- to, deliberately — that account is 5000 today and becomes 1090 after the
-- switch, and a view defined on it would have to be rewritten halfway
-- through the very transition it exists to verify.
--
-- Also carries the delivery's date and location now, so the aging that
-- reads it does not have to join back for them.

drop view if exists v_delivery_cost_unclaimed;

create view v_delivery_cost_unclaimed as
select
    c.id as consumption_id,
    c.company_id,
    c.stock_movement_id,
    sm.document_id,
    sm.document_line_id,
    sm.item_id,
    d.doc_no,
    d.posting_date,
    d.location_id,
    d.partner_id,
    c.unit_cost,
    c.qty as qty_delivered,
    c.qty - coalesce(sum(a.qty), 0) as qty_unclaimed,
    (c.qty - coalesce(sum(a.qty), 0)) * c.unit_cost as value_unclaimed
  from stock_lot_consumption c
  join stock_movement sm on sm.id = c.stock_movement_id
  join document_line dl on dl.id = sm.document_line_id
  join document d on d.id = dl.document_id
  left join sales_cost_allocation a on a.consumption_id = c.id
 where d.doc_type = 'DELIVERY'
   and d.status = 'POSTED'
   -- A giveaway was never going to be invoiced and its cost went to the
   -- reason's expense account when the goods left.
   and dl.foc_reason_id is null
   -- Consigned goods belong to somebody else; there is no cost of ours to
   -- hold anywhere.
   and coalesce(dl.is_consignment, false) = false
 group by c.id, c.company_id, c.stock_movement_id, sm.document_id,
          sm.document_line_id, sm.item_id, d.doc_no, d.posting_date,
          d.location_id, d.partner_id, c.unit_cost, c.qty
having c.qty - coalesce(sum(a.qty), 0) > 0.0001;

comment on view v_delivery_cost_unclaimed is
  'Delivered FIFO cost no sales invoice has claimed: posted deliveries only, excluding free-of-charge and consignment lines. Once cost of sales moves to the invoice this is what account 1090 must equal — see docs/03-decisions.md D8.';
