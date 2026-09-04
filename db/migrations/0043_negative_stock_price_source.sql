-- Where the provisional price came from.
--
-- The reconciliation screen has to say "45,000 per unit, from PI-001" rather
-- than presenting a figure from nowhere and asking someone to agree with it.
-- A number with no provenance is one people either accept without reading or
-- distrust without being able to check, and both are worse than being told.
--
-- Stored rather than looked up again at display time, because the price used
-- was the price known when the goods went out. Re-deriving it later would
-- quietly show today's answer beside a cost that was charged months ago.

alter table negative_stock
    add column if not exists price_source      text,
    add column if not exists price_source_no   text;

comment on column negative_stock.price_source is
    'PURCHASE_INVOICE, GOODS_RECEIPT or NONE — which kind of document the '
    'provisional unit cost was taken from.';
comment on column negative_stock.price_source_no is
    'That document''s number, for showing the user where the price came from.';

drop view if exists v_negative_stock;

create view v_negative_stock as
select
    ns.company_id,
    ns.id,
    ns.item_id,
    i.code   as item_code,
    i.name   as item_name,
    u.code   as uom_code,
    ns.location_id,
    l.code   as location_code,
    l.name   as location_name,
    ns.document_id,
    d.doc_no as document_no,
    d.doc_type,
    to_char(d.doc_date, 'YYYY-MM-DD') as doc_date,
    p.name   as partner_name,
    ns.qty,
    coalesce(s.settled, 0)          as settled,
    ns.qty - coalesce(s.settled, 0) as outstanding,
    ns.provisional_unit_cost,
    ns.price_source,
    ns.price_source_no,
    (ns.qty - coalesce(s.settled, 0)) * ns.provisional_unit_cost as outstanding_value,
    d.negative_stock_confirmed_at   as confirmed_at,
    d.negative_stock_confirmed_by   as confirmed_by,
    ns.created_at
  from negative_stock ns
  join item i     on i.id = ns.item_id
  join uom  u     on u.id = i.base_uom_id
  join location l on l.id = ns.location_id
  join document d on d.id = ns.document_id
  left join business_partner p on p.id = d.partner_id
  left join (
        select negative_stock_id, sum(qty) as settled
          from negative_stock_settlement group by negative_stock_id
  ) s on s.negative_stock_id = ns.id
 where ns.qty - coalesce(s.settled, 0) > 0.0001;

comment on view v_negative_stock is
    'Negative Stock — Pending Reconciliation. Stock issued that no receipt '
    'had covered, still awaiting one, with the price it was charged out at '
    'and the document that price came from.';
