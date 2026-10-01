-- A date the supplier gave is the only one worth scoring them against.
--
-- On-time delivery had nothing honest to measure. The only date a purchase
-- order carries is document.due_date, and the order form calls it "Needed
-- by" — it is when *we* want the goods, typed by whoever raised the order.
-- Scoring a supplier against it measures our optimism, not their reliability,
-- and a buyer who types next Tuesday on everything would sink every supplier
-- in the list.
--
-- So: the dates the supplier actually committed to, recorded separately.
--
-- A row is a quantity on a date, not a line on a date
-- ---------------------------------------------------
-- "100 units on the 10th" and, a week later, "40 of those on the 17th" is
-- an ordinary conversation with a supplier, and a single date per order line
-- cannot hold it. If it could only hold one, the whole 100 would be judged
-- against whichever date won, and a supplier who delivered 60 on time and 40
-- a week late would read as either wholly punctual or wholly late. Both are
-- wrong by 40 units.
--
-- So each row carries a quantity, and a line's commitment is a schedule
-- rather than a date. lib/supplier-commitments.ts turns the rows into that
-- schedule; the rules it applies are described there, not here, because they
-- are arithmetic rather than storage.
--
-- Append-only, and rows are never updated
-- ---------------------------------------
-- A supplier who confirms the 10th, then rings to say the 17th, then
-- delivers on the 17th has not delivered on time — they have moved the
-- goalposts once and hit them. If this table were updated in place the first
-- promise would vanish and their score would be perfect. The metric scores
-- against the original commitment; the later rows are kept because a
-- supplier who re-confirms repeatedly is telling you something worth reading
-- on its own, and because the revised date is what the warehouse actually
-- needs to plan around.
--
-- This follows order_closure and stock_lot_adjustment: rows accumulate, the
-- reader decides which one answers, nothing is ever erased.
--
-- Who moved the date decides whether the baseline moves
-- -----------------------------------------------------
-- A supplier ringing to say it will be late, and a buyer agreeing to push
-- the order back because the warehouse is full, produce the same new date
-- and mean opposite things. The first is the supplier missing a commitment
-- and should score as one. The second is us changing our mind, and holding
-- the supplier to the date we ourselves moved would be dishonest. `kind`
-- carries the difference, and it is required rather than defaulted: there
-- is no safe guess, and a system that guessed would quietly launder late
-- deliveries into agreed ones.
--
-- Why a table and not a column on document_line
-- ---------------------------------------------
-- A confirmation nearly always arrives after the order is placed, so the row
-- it belongs to is already posted. A posted purchase order happens to still
-- be editable — fn_document_line_immutable returns early when there is no
-- journal entry, and orders post nothing — but that is an accident of how
-- the guard is written, not a licence. It has already been tightened once,
-- for consignment receipts in 0028, and relying on it would make this
-- feature break the next time somebody tightens it properly.
--
-- Amending an order posts a new version and retires the old one, so a
-- confirmation naming a line on v1 is resolved the way fulfilment_link is
-- resolved: follow fn_current_document to the version standing now and match
-- on the item. Precise while an order is untouched, and graceful after an
-- amendment, which is the same trade v_order_outstanding already makes.

create table if not exists purchase_confirmation (
    id             uuid primary key default gen_random_uuid(),
    company_id     uuid not null references company(id) on delete cascade,

    /** The purchase order line the supplier committed to. */
    order_line_id  uuid not null references document_line(id) on delete cascade,

    /** How many units this commitment covers, in the line's base unit. A
     *  line is often confirmed in one row for its whole quantity; it is the
     *  second row, moving part of it, that this column exists for. */
    qty            numeric(18,4) not null check (qty > 0),

    /** The date the supplier said these units would arrive. Not a target,
     *  not a hope — what they told us, so that missing it is their miss. */
    confirmed_date date not null,

    /**
     * Who moved it, and therefore whether the baseline moves with it.
     *
     *   INITIAL           the first commitment for these units
     *   SUPPLIER_REVISION the supplier moving their own date; the original
     *                     stands as the baseline and this is the miss
     *   BUYER_AGREED      we asked for or accepted a different date; the
     *                     baseline moves, because holding a supplier to a
     *                     date we moved measures us
     */
    kind           text not null check (kind in
                       ('INITIAL', 'SUPPLIER_REVISION', 'BUYER_AGREED')),

    /** When we were told. This is what orders the rows, and what decides
     *  eligibility: a commitment recorded after the goods were already in,
     *  or after the date it names had passed, is a note about the past
     *  rather than a promise about the future, and scoring against it would
     *  let a supplier confirm their way to a clean record afterwards. */
    recorded_at    timestamptz not null default now(),

    /** How it arrived — an email, a phone call, their order acknowledgement.
     *  A date nobody can source is a date nobody will defend in a supplier
     *  review. */
    source         text,
    note           text,

    /** Waits for the user model this app has not built, exactly as
     *  fulfilment_link.linked_by does. Null now means visibly unattributed
     *  later, rather than silently attributed to the wrong person. */
    recorded_by    text
);

create index if not exists purchase_confirmation_line_idx
    on purchase_confirmation (order_line_id, recorded_at);
create index if not exists purchase_confirmation_company_idx
    on purchase_confirmation (company_id, confirmed_date);

comment on table purchase_confirmation is
    'What a supplier committed to for one purchase order line: a quantity, a '
    'date, and when we were told. Append-only. The original commitment is '
    'what on-time delivery is scored against; later rows record it moving, '
    'and who moved it.';

comment on column purchase_confirmation.kind is
    'INITIAL, SUPPLIER_REVISION (baseline stands, the supplier missed it) or '
    'BUYER_AGREED (baseline moves, we changed our mind). Required: guessing '
    'would quietly turn late deliveries into agreed ones.';

-- Append-only in the same way stock_lot_adjustment is: refused at the
-- database, not merely avoided by the application, because the application
-- is not the only writer.
create or replace function fn_purchase_confirmation_immutable() returns trigger
language plpgsql as $$
begin
    raise exception
        'A confirmation is a record of what was said on a date. Record '
        'another one instead of changing this.';
end;
$$;

drop trigger if exists trg_purchase_confirmation_immutable on purchase_confirmation;
create trigger trg_purchase_confirmation_immutable
    before update or delete on purchase_confirmation
    for each row execute function fn_purchase_confirmation_immutable();

-- A confirmation belongs to a purchase order line and nothing else. Without
-- this it would accept a sales invoice line, and the metric would quietly
-- score a supplier on a document they never saw.
create or replace function fn_purchase_confirmation_line_is_an_order()
returns trigger language plpgsql as $$
declare
    v_type text;
begin
    select d.doc_type into v_type
      from document_line dl
      join document d on d.id = dl.document_id
     where dl.id = NEW.order_line_id;

    if v_type is distinct from 'PURCHASE_ORDER' then
        raise exception
            'A delivery confirmation belongs to a purchase order line, not '
            'to a % line', coalesce(v_type, 'missing');
    end if;

    return NEW;
end;
$$;

drop trigger if exists trg_purchase_confirmation_line_is_an_order
    on purchase_confirmation;
create trigger trg_purchase_confirmation_line_is_an_order
    before insert on purchase_confirmation
    for each row execute function fn_purchase_confirmation_line_is_an_order();
