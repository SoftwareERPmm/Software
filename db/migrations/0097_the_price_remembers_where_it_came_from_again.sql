-- The price remembers where it came from, again.
--
-- 0043 added price_source and price_source_no to negative_stock and to
-- v_negative_stock, for a stated reason: the reconciliation screen has to say
-- "45,000 per unit, from PI-001" rather than present a figure from nowhere
-- and ask somebody to agree with it.
--
-- 0068 added the "reason never recorded" columns and rebuilt the view to do
-- it. The rebuild was written from the 0042 shape rather than the 0043 one,
-- so the two provenance columns quietly fell out. Nothing failed: the engine
-- kept writing them to the table — it still does, at lib/posting.ts — and
-- the number on the screen stayed correct. Only the answer to "where did
-- this come from" disappeared, which is the hardest kind of regression to
-- notice, because what is left looks complete.
--
-- Caught by scripts/test-negative-stock.mjs, which has asserted
-- `price_source === 'PURCHASE_INVOICE'` since 0043 and had been failing ever
-- since — hidden behind an unrelated crash that stopped the suite before it
-- could report.

-- Dropped and recreated rather than replaced: CREATE OR REPLACE VIEW cannot
-- change a column's type or insert one mid-list, and doc_date is rendered as
-- text here. Nothing depends on this view, so the drop is contained.
drop view if exists v_negative_stock;

create view v_negative_stock as
select
    ns.company_id,
    ns.id,
    ns.item_id,
    i.code   as item_code,
    i.name   as item_name,
    ns.location_id,
    l.code   as location_code,
    l.name   as location_name,
    ns.document_id,
    d.doc_no as document_no,
    d.doc_type,
    to_char(d.doc_date, 'YYYY-MM-DD') as doc_date,
    ns.qty,
    coalesce(s.settled, 0)              as settled,
    ns.qty - coalesce(s.settled, 0)     as outstanding,
    ns.provisional_unit_cost,
    (ns.qty - coalesce(s.settled, 0)) * ns.provisional_unit_cost
                                        as outstanding_value,
    ns.price_source,
    ns.price_source_no,
    d.negative_stock_confirmed_at       as confirmed_at,
    d.negative_stock_confirmed_by       as confirmed_by,
    d.negative_stock_reason             as confirmed_reason,
    d.negative_stock_reason_legacy      as reason_is_legacy,
    ns.created_at
  from negative_stock ns
  join item i on i.id = ns.item_id
  join location l on l.id = ns.location_id
  join document d on d.id = ns.document_id
  left join (
      select negative_stock_id, sum(qty) as settled
        from negative_stock_settlement
       group by negative_stock_id
  ) s on s.negative_stock_id = ns.id
 where ns.qty - coalesce(s.settled, 0) > 0.0001;
