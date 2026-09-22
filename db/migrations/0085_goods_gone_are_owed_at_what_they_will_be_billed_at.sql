-- Goods already gone count at what they will be billed at.
--
-- 0084 valued unbilled deliveries from the delivery itself. A delivery is
-- valued at cost — its lines carry what the stock was worth leaving the
-- shelf, not what the customer will pay for it — so ten units sold at 10,000
-- each showed as 5,000 of exposure instead of 100,000. A credit check that
-- understates by the entire margin is barely a credit check.
--
-- Where the delivery answers an order or a to-deliver invoice, that document
-- has the price this customer agreed. Where it answers nothing — goods sent
-- without paperwork — cost is all this app knows, and cost is used, because
-- a low figure is still better than pretending there is no exposure at all.

create or replace view v_customer_credit as
  with unbilled as (
    select d.partner_id,
           sum(
             case
               when src.unit_price is not null and src.unit_price > 0
                 then l.base_qty * src.unit_price
               else l.net_amount
             end
           ) as value
      from document d
      join document_line l on l.document_id = d.id
      left join document_line src on src.id = l.source_line_id
     where d.doc_type = 'DELIVERY' and d.status = 'POSTED'
       and not exists (
         select 1 from document si
          where si.doc_type = 'SALES_INVOICE' and si.status = 'POSTED'
            and (si.source_document_id = d.id or d.source_document_id = si.id)
       )
     group by d.partner_id
  )
  select p.company_id,
         p.id                        as partner_id,
         p.code                      as partner_code,
         p.name                      as partner_name,
         p.credit_limit,
         coalesce(oi.outstanding, 0) as outstanding,
         coalesce(un.value, 0)       as unbilled_deliveries,
         coalesce(oi.outstanding, 0) + coalesce(un.value, 0) as exposure,
         case
           when p.credit_limit is null then null
           else p.credit_limit - (coalesce(oi.outstanding, 0) + coalesce(un.value, 0))
         end                         as available
    from business_partner p
    left join (
      select partner_id, sum(outstanding) as outstanding
        from v_open_item
       where doc_type = 'SALES_INVOICE'
       group by partner_id
    ) oi on oi.partner_id = p.id
    left join unbilled un on un.partner_id = p.id
   where p.is_customer;
