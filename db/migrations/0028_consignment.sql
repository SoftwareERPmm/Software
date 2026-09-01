-- 0028_consignment.sql
-- Consignment: goods that arrive but are not yet owned.
--
-- A normal goods receipt says "we now own this and owe the supplier for it" -
-- Dr Inventory / Cr GR/IR Clearing, immediately. Consignment stock is
-- different on purpose: the goods sit in the warehouse, visible and
-- sellable, but nothing is owed until a specific unit actually sells. Only
-- then does a purchase - and a payable - get recognized, at the rate that
-- particular batch was agreed to settle at.
--
-- The hierarchy, and why each level exists:
--
--   consignment_agreement       one per consignor (business_partner). The
--                                default arrangement with that supplier.
--   consignment_agreement_line  which items are covered, and the DEFAULT
--                                settlement rule for each - a percentage of
--                                the selling price, or a fixed cost.
--   consignment_lot             one per item per receipt. Freezes a COPY of
--                                the rate from the agreement line at the
--                                moment of receipt, because the agreement's
--                                rate can change between shipments and a lot
--                                must keep settling at whatever it actually
--                                arrived under - the same reason a stock_lot
--                                freezes unit_cost rather than pointing back
--                                at "whatever the item costs now".
--   consignment_lot_consumption records which lot a later sale drew from,
--                                and how much - defined now, written by the
--                                sale-side integration in a later step. A
--                                consumption row exists whether or not it has
--                                been settled yet (settlement_document_id is
--                                null until the sales invoice that settles it
--                                posts).
--
-- Deliberately built as tables of their own rather than reusing stock_lot /
-- stock_lot_consumption: those tables, and everything that reads them
-- (planFifoConsumption, GR/IR matching, the adversarial suite), represent
-- owned inventory. Consigned stock is not owned inventory until it sells, so
-- routing it through the same tables would mean either teaching every one of
-- those readers about an "owned" flag, or accepting that a consigned lot
-- with unit_cost = 0 sits in the same FIFO layer set as real stock - which is
-- exactly the kind of mixing this design exists to avoid. A parallel, purely
-- additive schema keeps every existing FIFO invariant untouched.
--
-- The receipt itself IS a real `document` row - CONSIGNMENT_RECEIPT - with
-- its own number, in the Documents list, chainable like anything else. What
-- makes it unusual is that it deliberately never gets a journal_entry_id:
-- custody changed, value did not, so there is nothing to post. That is new
-- enough to need two small trigger amendments below.

alter table document drop constraint document_doc_type_check;
alter table document add constraint document_doc_type_check
    check (doc_type = any (array[
        'PURCHASE_ORDER','GOODS_RECEIPT','PURCHASE_INVOICE','PURCHASE_RETURN',
        'SUPPLIER_PAYMENT','SALES_ORDER','DELIVERY','SALES_INVOICE',
        'SALES_RETURN','CUSTOMER_RECEIPT','STOCK_ADJUSTMENT','STOCK_TRANSFER',
        'OPENING_BALANCE','CASH_VOUCHER','BANK_VOUCHER','JOURNAL_VOUCHER',
        'CASH_TRANSFER','CONSIGNMENT_RECEIPT'
    ]));

-- fn_document_posting_required already only requires a journal entry for an
-- explicit allowlist of doc_types (0014). CONSIGNMENT_RECEIPT is simply not
-- on it, so that guard needs no change - a document off the list can be
-- POSTED with journal_entry_id null and nothing complains. Which is exactly
-- the gap in the two triggers below: they read "journal_entry_id is null" as
-- "posting is still assembling this row", true for every existing type
-- because they all get one moments later, but permanently true for a
-- consignment receipt - so under the old logic one would stay editable
-- forever, its lines included.

create or replace function fn_document_immutable() returns trigger
language plpgsql as $$
begin
    if (TG_OP = 'DELETE') then
        if OLD.status <> 'DRAFT' then
            raise exception
                'Document % is % and cannot be deleted. Post a reversal instead',
                OLD.doc_no, OLD.status;
        end if;
        return OLD;
    end if;

    -- A consignment receipt never carries a journal entry, so for that type
    -- alone, "no journal entry yet" is not the assembling window every other
    -- type gets one internal update during - it is permanent. POSTED means
    -- frozen immediately, the same as everywhere else once a value IS set.
    if OLD.doc_type <> 'CONSIGNMENT_RECEIPT' and OLD.journal_entry_id is null then
        return NEW;
    end if;

    if NEW.company_id     is distinct from OLD.company_id
    or NEW.doc_type       is distinct from OLD.doc_type
    or NEW.doc_no         is distinct from OLD.doc_no
    or NEW.partner_id     is distinct from OLD.partner_id
    or NEW.doc_date       is distinct from OLD.doc_date
    or NEW.posting_date   is distinct from OLD.posting_date
    or NEW.net_total      is distinct from OLD.net_total
    or NEW.tax_total      is distinct from OLD.tax_total
    or NEW.gross_total    is distinct from OLD.gross_total
    or NEW.status         is distinct from OLD.status
    or NEW.journal_entry_id is distinct from OLD.journal_entry_id
    then
        raise exception
            'Document % is posted; its totals, dates, partner and status are '
            'fixed. Post a reversal or a correcting document instead',
            OLD.doc_no;
    end if;

    return NEW;
end;
$$;

create or replace function fn_document_line_immutable() returns trigger
language plpgsql as $$
declare
    v_entry  uuid;
    v_status text;
    v_type   text;
    v_no     text;
begin
    select journal_entry_id, status, doc_type, doc_no
      into v_entry, v_status, v_type, v_no
      from document where id = coalesce(OLD.document_id, NEW.document_id);

    -- Same reasoning as fn_document_immutable above: a consignment receipt's
    -- lines freeze the moment the document is POSTED, not when a journal
    -- entry turns up, because one never will.
    if v_type = 'CONSIGNMENT_RECEIPT' then
        if v_status = 'POSTED' then
            raise exception
                'Document % is posted; its lines cannot be changed or removed. '
                'Post a reversal or a correcting document instead', v_no;
        end if;
        return coalesce(NEW, OLD);
    end if;

    if v_entry is null then
        return coalesce(NEW, OLD);
    end if;

    raise exception
        'Document % is posted; its lines cannot be changed or removed. '
        'Post a reversal or a correcting document instead', v_no;
end;
$$;

-- fn_next_document_no already switches on doc_type to pick a prefix; add
-- this one rather than let it fall through to the generic left(type,3)
-- fallback, so the number reads as what it is rather than as "CON-".
create or replace function fn_next_document_no(
    p_company uuid, p_type text, p_fiscal_year uuid
) returns text language plpgsql as $$
declare
    s     number_series;
    v_pfx text;
begin
    select * into s from number_series
     where company_id = p_company
       and document_type = p_type
       and fiscal_year_id is not distinct from p_fiscal_year
     for update;

    if not found then
        v_pfx := case p_type
            when 'PURCHASE_ORDER'      then 'PO-'
            when 'GOODS_RECEIPT'       then 'GR-'
            when 'PURCHASE_INVOICE'    then 'PI-'
            when 'PURCHASE_RETURN'     then 'PR-'
            when 'SUPPLIER_PAYMENT'    then 'PAY-'
            when 'SALES_ORDER'         then 'SO-'
            when 'DELIVERY'            then 'DO-'
            when 'SALES_INVOICE'       then 'SI-'
            when 'SALES_RETURN'        then 'SR-'
            when 'CUSTOMER_RECEIPT'    then 'RC-'
            when 'STOCK_ADJUSTMENT'    then 'ADJ-'
            when 'STOCK_TRANSFER'      then 'TRF-'
            when 'OPENING_BALANCE'     then 'OB-'
            when 'CASH_VOUCHER'        then 'CV-'
            when 'BANK_VOUCHER'        then 'BV-'
            when 'JOURNAL_VOUCHER'     then 'JV-'
            when 'CASH_TRANSFER'       then 'CT-'
            when 'JOURNAL'             then 'JE-'
            when 'CONSIGNMENT_RECEIPT' then 'CNR-'
            else left(p_type, 3) || '-'
        end;

        insert into number_series (company_id, document_type, fiscal_year_id, prefix, next_value)
        values (p_company, p_type, p_fiscal_year, v_pfx, 1)
        returning * into s;
    end if;

    update number_series set next_value = next_value + 1 where id = s.id;

    return s.prefix || fn_document_no_year(p_fiscal_year)
           || lpad(s.next_value::text, s.padding, '0');
end;
$$;

-- ------------------------------------------------------------- schema --

create table consignment_agreement (
    id         uuid primary key default gen_random_uuid(),
    company_id uuid not null references company(id),
    partner_id uuid not null references business_partner(id),
    memo       text,
    created_at timestamptz not null default now(),

    -- One arrangement per consignor. A supplier with genuinely different
    -- concurrent terms is a real case, but not one raised yet - relax this
    -- when it is, rather than guess at the shape now.
    unique (company_id, partner_id)
);

create index on consignment_agreement (company_id, partner_id);

-- Consigned goods can only ever come from a supplier - guarded the same way
-- a control account's role is guarded, in a trigger rather than a bare CHECK,
-- because a CHECK cannot reference another table.
create or replace function fn_consignment_agreement_guard() returns trigger
language plpgsql as $$
declare
    p business_partner;
begin
    select * into p from business_partner where id = new.partner_id;
    if not found then
        raise exception 'Partner % does not exist', new.partner_id;
    end if;
    if not p.is_supplier then
        raise exception
            'Partner % is not a supplier and cannot be a consignor', p.code;
    end if;
    return new;
end;
$$;

create trigger trg_consignment_agreement_guard
    before insert or update on consignment_agreement
    for each row execute function fn_consignment_agreement_guard();

create table consignment_agreement_line (
    id            uuid primary key default gen_random_uuid(),
    company_id    uuid not null references company(id),
    agreement_id  uuid not null references consignment_agreement(id),
    item_id       uuid not null references item(id),

    pricing_method text not null check (pricing_method in ('PERCENTAGE', 'FIXED')),
    -- PERCENTAGE: a share of the selling price, e.g. 80 meaning 80%.
    -- FIXED: a flat settlement cost per unit, in the company's currency.
    pricing_value  numeric(18,4) not null check (pricing_value > 0),

    is_active     boolean not null default true,
    created_at    timestamptz not null default now(),

    unique (agreement_id, item_id),
    constraint consignment_agreement_line_percentage_range
        check (pricing_method <> 'PERCENTAGE' or pricing_value <= 100)
);

create index on consignment_agreement_line (company_id, agreement_id);
create index on consignment_agreement_line (item_id);

create table consignment_lot (
    id            uuid primary key default gen_random_uuid(),
    company_id    uuid not null references company(id),
    item_id       uuid not null references item(id),
    location_id   uuid not null references location(id),

    -- Which line this batch was received under, so the consignor and the
    -- default rate can be traced back even if the agreement line is later
    -- edited or deactivated.
    agreement_line_id   uuid not null references consignment_agreement_line(id),
    receipt_document_id uuid not null references document(id),

    -- Frozen at receipt, the same reason stock_lot freezes unit_cost: the
    -- agreement's default can change between shipments, and this lot has to
    -- keep settling at whatever it actually arrived under.
    pricing_method text not null check (pricing_method in ('PERCENTAGE', 'FIXED')),
    pricing_value  numeric(18,4) not null check (pricing_value > 0),

    received_date  date not null,
    qty_received   numeric(18,4) not null check (qty_received > 0),
    created_at     timestamptz not null default now()
);

create index on consignment_lot (company_id, item_id, location_id, received_date, created_at);
create index on consignment_lot (receipt_document_id);

-- Defined now, written to starting with the sale-side integration. A
-- consumption row exists the moment a delivery draws from the lot;
-- settlement_document_id fills in once the sales invoice that settles it
-- posts, which is how "delivered but not yet invoiced" consignment stock is
-- told apart from "settled".
create table consignment_lot_consumption (
    id            uuid primary key default gen_random_uuid(),
    company_id    uuid not null references company(id),
    lot_id        uuid not null references consignment_lot(id),

    delivery_document_id   uuid not null references document(id),
    qty                     numeric(18,4) not null check (qty > 0),
    settlement_document_id  uuid references document(id),

    created_at    timestamptz not null default now()
);

create index on consignment_lot_consumption (company_id, lot_id);
create index on consignment_lot_consumption (delivery_document_id);
create index on consignment_lot_consumption (settlement_document_id) where settlement_document_id is not null;

-- Append-only, matching stock_lot / stock_lot_consumption exactly: a mistake
-- here is corrected with a reversing entry, never an edit.
create or replace function fn_consignment_lot_immutable() returns trigger
language plpgsql as $$
begin
    raise exception 'Consignment lots are append-only. Post a reversing movement instead.';
end;
$$;

create trigger trg_consignment_lot_immutable
    before update or delete on consignment_lot
    for each row execute function fn_consignment_lot_immutable();

create or replace function fn_consignment_lot_consumption_immutable() returns trigger
language plpgsql as $$
begin
    raise exception 'Consignment lot consumption is append-only. Post a reversing movement instead.';
end;
$$;

create trigger trg_consignment_lot_consumption_immutable
    before update or delete on consignment_lot_consumption
    for each row execute function fn_consignment_lot_consumption_immutable();

comment on table consignment_agreement is
    'One arrangement per consignor. Items and their default settlement rates '
    'live on consignment_agreement_line.';
comment on table consignment_lot is
    'One row per item per consignment receipt. Carries no value on its own - '
    'the pricing_method/pricing_value frozen here is what a later sale, not '
    'this receipt, will settle against.';
comment on table consignment_lot_consumption is
    'One row per (delivery, lot) draw. settlement_document_id is null until '
    'the sales invoice that recognizes the purchase and payable posts.';
