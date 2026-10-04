-- Lookups that had no index of their own.
--
-- Each of these columns is indexed only behind company_id, which serves a
-- query that names the company and nothing that joins on the column alone —
-- and these are joined on alone:
--
--   payment_allocation.invoice_id      what an invoice has been paid, read by
--                                      v_open_item for every open item listed
--   stock_lot_consumption.lot_id       what is left in a lot, read by FIFO on
--                                      every issue
--   sales_cost_allocation.reverses_id  whether a claim has been released, read
--                                      by the shipped-not-invoiced figure
--   journal_line.location_id           every branch report
--
-- Small tables today, so nothing is slow yet. Cheap to add before they are not.

create index if not exists payment_allocation_invoice_idx
    on payment_allocation (invoice_id);

create index if not exists stock_lot_consumption_lot_idx
    on stock_lot_consumption (lot_id);

create index if not exists sales_cost_allocation_reverses_idx
    on sales_cost_allocation (reverses_id) where reverses_id is not null;

create index if not exists journal_line_location_idx
    on journal_line (company_id, location_id) where location_id is not null;
