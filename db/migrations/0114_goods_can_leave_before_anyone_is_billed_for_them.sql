-- Groundwork for recognising cost of sales on the invoice instead of the
-- delivery. See docs/03-decisions.md, D8.
--
-- Nothing here changes a single posting. The engine still relieves inventory
-- straight to cost of sales when goods leave, exactly as it did before this
-- migration. What this adds is the two things that change cannot be built
-- without: somewhere for the cost of shipped-but-unbilled goods to sit, and
-- a record of which delivered cost each invoice line has claimed.
--
-- The second is the part that is easy to underestimate. The sales report
-- already matches invoices to deliveries, but it recomputes the match on
-- every page load, which is safe only because nothing is posted from it.
-- Once an invoice posts cost of sales, the match stops being an opinion and
-- becomes a ledger fact: voiding that invoice has to put back exactly what
-- it took, and the match cannot be recomputed at void time because other
-- invoices may have claimed the same delivery since, and the answer depends
-- on the order they claimed in.

-- ------------------------------------------------- goods shipped, not billed

-- The sales mirror of 1060 GR/IR Clearing. Goods have left the building and
-- nobody has been invoiced for them: the cost is out of inventory and is not
-- yet cost of sales, so it is an asset in between. For companies that already
-- exist — new ones get it from db/chart.mjs, which is where it is defined.
insert into account (company_id, code, name, account_type, is_postable, parent_id)
select c.id, '1090', 'Goods Shipped Not Invoiced', 'ASSET', true,
       (select a.id from account a
         where a.company_id = c.id and a.account_type = 'ASSET'
           and a.is_postable = false
         order by a.code limit 1)
  from company c
 where not exists (
   select 1 from account a where a.company_id = c.id and a.code = '1090'
 );

alter table system_account drop constraint if exists system_account_role_check;
alter table system_account add constraint system_account_role_check check (
  role = any (array[
    'GRIR_CLEARING', 'PURCHASE_PRICE_VARIANCE', 'PURCHASE_DISCOUNT_RECEIVED',
    'SALES_DISCOUNT_ALLOWED', 'STOCK_ADJUSTMENT', 'PROMOTION_EXPENSE',
    'FX_GAIN', 'FX_LOSS', 'ROUNDING_DIFFERENCE', 'OPENING_BALANCE_EQUITY',
    'RETAINED_EARNINGS', 'DELIVERY_INCOME', 'CUSTOMER_ADVANCE', 'SUPPLIER_ADVANCE',
    'OUTPUT_TAX', 'INPUT_TAX', 'SHIPPED_NOT_INVOICED'
  ])
);

insert into system_account (company_id, role, account_id)
select c.id, 'SHIPPED_NOT_INVOICED', a.id
  from company c
  join account a on a.company_id = c.id and a.code = '1090'
 where not exists (
   select 1 from system_account s
    where s.company_id = c.id and s.role = 'SHIPPED_NOT_INVOICED'
 );

-- ------------------------------------------------ which cost an invoice took

-- One row per claim an invoice line makes on delivered cost, against the
-- individual FIFO layer that cost came out of. Claiming per consumption row
-- rather than per delivery line is deliberate: a delivery that drew from two
-- layers at different costs hands the invoice the exact cost of the units it
-- bills, instead of an average that is right only in total.
--
-- Append-only, like stock_lot_consumption and for the same reason: a claim
-- that was posted happened, and undoing it is a release, not an edit. A
-- release is a negative row naming the claim it undoes, so the net of a
-- consumption's rows is what is currently claimed against it and the history
-- of how it got there survives.
create table sales_cost_allocation (
    id              uuid primary key default gen_random_uuid(),
    company_id      uuid not null references company(id),

    -- The invoice line taking the cost.
    invoice_line_id uuid not null references document_line(id),
    -- The delivered cost being taken, at the layer it came from.
    consumption_id  uuid not null references stock_lot_consumption(id),

    qty             numeric(18,4) not null check (qty <> 0),
    unit_cost       numeric(18,4) not null,

    -- A release names the claim it reverses; a claim names nothing. The
    -- direction follows from that, so a row cannot be a claim with a
    -- negative quantity or a release with a positive one.
    reverses_id     uuid references sales_cost_allocation(id),

    created_at      timestamptz not null default now(),

    constraint sales_cost_allocation_direction check (
        (reverses_id is null and qty > 0) or (reverses_id is not null and qty < 0))
);

create index on sales_cost_allocation (consumption_id);
create index on sales_cost_allocation (invoice_line_id);
create index on sales_cost_allocation (company_id);

create or replace function fn_sales_cost_allocation_immutable() returns trigger
language plpgsql as $$
begin
    raise exception
        'Cost allocations are append-only. Write a releasing row instead.';
end;
$$;

create trigger trg_sales_cost_allocation_immutable
    before update or delete on sales_cost_allocation
    for each row execute function fn_sales_cost_allocation_immutable();

-- The whole point of the table: goods can be claimed once. Without this an
-- invoice could take cost a second invoice had already taken, and the two
-- would both look right on their own.
create or replace function fn_sales_cost_allocation_within_consumption() returns trigger
language plpgsql as $$
declare
    v_claimed   numeric;
    v_available numeric;
    v_company   uuid;
    v_claim     numeric;
    v_released  numeric;
begin
    select c.qty, c.company_id into v_available, v_company
      from stock_lot_consumption c where c.id = new.consumption_id;

    if v_company <> new.company_id then
        raise exception
            'Cost allocation crosses companies: the goods belong to another company';
    end if;

    select coalesce(sum(a.qty), 0) into v_claimed
      from sales_cost_allocation a where a.consumption_id = new.consumption_id;

    -- A tenth of the smallest quantity the column can hold, so rounding at
    -- the fourth decimal cannot trip a guard that is about double-claiming.
    if v_claimed > v_available + 0.00005 then
        raise exception
            'Cost allocation claims % units of goods that moved only %',
            v_claimed, v_available;
    end if;

    if v_claimed < -0.00005 then
        raise exception
            'Cost allocation releases more than was ever claimed';
    end if;

    -- And a release cannot undo more than the claim it names, even where
    -- the total still looks sound because another claim is covering it.
    if new.reverses_id is not null then
        select a.qty into v_claim
          from sales_cost_allocation a where a.id = new.reverses_id;
        select coalesce(sum(-a.qty), 0) into v_released
          from sales_cost_allocation a where a.reverses_id = new.reverses_id;
        if v_released > v_claim + 0.00005 then
            raise exception
                'Cost allocation releases % against a claim of only %',
                v_released, v_claim;
        end if;
    end if;

    return null;
end;
$$;

create trigger trg_sales_cost_allocation_within_consumption
    after insert on sales_cost_allocation
    for each row execute function fn_sales_cost_allocation_within_consumption();

-- Delivered cost nobody has billed for yet, which is what 1090 will hold
-- once cost moves to the invoice. Useful before then too: it is the aging
-- list for goods shipped and not invoiced, the sales mirror of the GR/IR
-- worklist that already exists on the purchase side.
create view v_delivery_cost_unclaimed as
select
    c.id as consumption_id,
    c.company_id,
    c.stock_movement_id,
    sm.document_id,
    sm.document_line_id,
    sm.item_id,
    c.unit_cost,
    c.qty as qty_delivered,
    c.qty - coalesce(sum(a.qty), 0) as qty_unclaimed,
    (c.qty - coalesce(sum(a.qty), 0)) * c.unit_cost as value_unclaimed
  from stock_lot_consumption c
  join stock_movement sm on sm.id = c.stock_movement_id
  left join sales_cost_allocation a on a.consumption_id = c.id
 group by c.id, c.company_id, c.stock_movement_id, sm.document_id,
          sm.document_line_id, sm.item_id, c.unit_cost, c.qty
having c.qty - coalesce(sum(a.qty), 0) > 0.0001;

comment on table sales_cost_allocation is
  'Which delivered FIFO cost each sales invoice line has claimed. Append-only; a release is a negative row naming the claim it reverses. Nothing posts from this yet — see docs/03-decisions.md D8.';
