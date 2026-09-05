-- Volume discount, kept apart from the discount typed on a line.
--
-- Three different things were being called "discount" and stored in one
-- field, which meant an invoice could show 8% off and nothing could say why:
--
--   Item discount    typed on the line, for this sale, this customer
--   Volume discount  earned by the quantity bought, or by the invoice total
--   FOC              not a discount at all — extra goods at zero revenue,
--                    which still leave the warehouse
--
-- FOC already worked this way (a separate zero-price line carrying a reason,
-- issued from stock). Item discount already existed. What did not exist was
-- the volume discount: `promotion.discount_pct` has been in the schema since
-- 0003 and was never applied to anything, because promoFor() only ever
-- matched the buy-N-get-M style.
--
-- Two bases, and they stack. A line can earn a quantity discount while the
-- invoice it sits on separately earns one for its total — 5% for taking a
-- hundred units, another 3% because the bill passed ten million. Applied in
-- that order, each to the figure the previous left, so the invoice discount
-- is a discount on what is actually being charged rather than on a subtotal
-- nobody is paying.
--
-- Not hung off `promotion`, deliberately. A promotion is scoped to an item or
-- a category by design; an invoice-total rule is scoped to neither, and
-- bending the table to hold both would make every promotion query answer a
-- question about invoices it has no business answering.

create table if not exists volume_discount (
    id            uuid primary key default gen_random_uuid(),
    company_id    uuid not null references company(id),
    code          text not null,
    name          text not null,

    -- QUANTITY bands are read against a line's quantity; INVOICE_TOTAL bands
    -- against the invoice's own subtotal after line discounts.
    basis         text not null check (basis in ('QUANTITY', 'INVOICE_TOTAL')),

    -- A quantity band may narrow to one item or one category. An invoice-total
    -- band applies to the whole invoice and cannot be scoped to either — the
    -- check below is what stops a rule that could never be evaluated.
    item_id       uuid references item(id),
    item_group_id uuid references item_group(id),

    min_value     numeric(18,4) not null check (min_value >= 0),
    -- Null is "and above", so the top band needs no invented ceiling.
    max_value     numeric(18,4),

    discount_pct  numeric(9,6) not null
        check (discount_pct >= 0 and discount_pct <= 100),

    valid_from    date not null,
    valid_to      date,
    is_active     boolean not null default true,
    created_at    timestamptz not null default now(),

    unique (company_id, code),
    check (max_value is null or max_value >= min_value),
    check (valid_to is null or valid_to >= valid_from),
    check (basis <> 'INVOICE_TOTAL' or (item_id is null and item_group_id is null)),
    check (item_id is null or item_group_id is null)
);

create index if not exists volume_discount_lookup_idx
    on volume_discount (company_id, basis, is_active);

comment on table volume_discount is
    'Quantity and invoice-total discount bands. Both may apply to one line: '
    'the quantity band on what was bought, the invoice band on the bill.';
comment on column volume_discount.max_value is
    'Upper bound of the band, inclusive. Null means no upper bound.';

-- --------------------------------------------------------------- the line --

-- Kept apart from discount_pct rather than added to it. The whole point is
-- that an invoice can say which part of a reduction was given by the seller
-- and which was earned by the order, and one summed field cannot.
alter table document_line
    add column if not exists volume_discount_pct    numeric(9,6)  not null default 0,
    add column if not exists volume_discount_amount numeric(18,4) not null default 0,
    -- Which band did it, so the line can name the rule rather than just the
    -- percentage. Null on a line that earned none.
    add column if not exists volume_discount_id     uuid references volume_discount(id),
    add column if not exists invoice_discount_pct    numeric(9,6)  not null default 0,
    add column if not exists invoice_discount_amount numeric(18,4) not null default 0,
    add column if not exists invoice_discount_id     uuid references volume_discount(id);

comment on column document_line.discount_pct is
    'The discount typed on this line by whoever raised it. Trade discount: '
    'netted into net_amount, posts nothing of its own.';
comment on column document_line.volume_discount_pct is
    'Earned by this line''s quantity, from a QUANTITY band. Netted the same '
    'way; recorded separately so the invoice can say why it was given.';
comment on column document_line.invoice_discount_pct is
    'Earned by the invoice''s total, from an INVOICE_TOTAL band, and spread '
    'across the lines so revenue per item stays right.';
