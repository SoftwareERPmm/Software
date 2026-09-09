-- A settlement can be voided and raised again, and both are on the record.
--
-- 0049 made the goods behind a voided settlement findable again, which was
-- half the job. The other half was still refused: the link lives in
-- consignment_lot_consumption.settlement_document_id, and 0030 permits that
-- column to go from empty to its first settlement and never to change again.
-- So a replacement settlement selected the goods, priced them, posted its
-- payable, and then rolled the whole transaction back on the last statement.
--
-- Verified on 2026-09-07: re-stamping a consumption row is refused with
-- "Consignment lot consumption is append-only."
--
-- That rule is right. The answer is not to relax it — overwriting the link
-- would erase the fact that a first settlement ever covered these goods,
-- which is exactly the history a void is supposed to preserve. So the link
-- moves to a table of its own, one row per attempt, appended and never
-- changed. "Settled" stops being a column and becomes a question: is there
-- an attempt on this consumption whose document still stands?
--
-- The old column stays, and keeps its meaning — the first settlement, once,
-- exactly as 0030 wrote it. Nothing that reads it needs changing, and it is
-- no longer the thing that decides.

create table if not exists consignment_settlement_line (
    id             uuid primary key default gen_random_uuid(),
    company_id     uuid not null references company(id),
    consumption_id uuid not null references consignment_lot_consumption(id),
    settlement_document_id uuid not null references document(id),

    -- What this attempt settled the goods at, kept here rather than
    -- recomputed: the agreement's rate can change, and an attempt has to
    -- stay readable as what it actually claimed at the time.
    qty            numeric(18,4) not null check (qty > 0),
    amount         numeric(18,4) not null,

    created_at     timestamptz not null default now(),

    -- One attempt per settlement per consumption. A settlement that ran twice
    -- over the same goods is a double payment to the consignor.
    unique (consumption_id, settlement_document_id)
);

create index if not exists consignment_settlement_line_consumption_idx
    on consignment_settlement_line (consumption_id);
create index if not exists consignment_settlement_line_document_idx
    on consignment_settlement_line (settlement_document_id);

comment on table consignment_settlement_line is
    'Every settlement raised against consumed consigned goods, including ones '
    'later voided. Append-only: a replacement is a new row, never an edit, so '
    'what was claimed and when survives the correction.';

create or replace function fn_consignment_settlement_line_immutable() returns trigger
language plpgsql as $$
begin
    raise exception
        'Consignment settlement lines are append-only. Void the settlement and '
        'raise a replacement instead.';
end;
$$;

drop trigger if exists trg_consignment_settlement_line_immutable
    on consignment_settlement_line;
create trigger trg_consignment_settlement_line_immutable
    before update or delete on consignment_settlement_line
    for each row execute function fn_consignment_settlement_line_immutable();

-- Everything already settled, so the new table is the whole truth from the
-- first read rather than only from the next settlement onward. The amount is
-- what that settlement's document line carried for the item.
insert into consignment_settlement_line
    (company_id, consumption_id, settlement_document_id, qty, amount)
select c.company_id, c.id, c.settlement_document_id, c.qty,
       coalesce((
         select dl.net_amount
           from document_line dl
           join consignment_lot cl on cl.id = c.lot_id
          where dl.document_id = c.settlement_document_id
            and dl.item_id = cl.item_id
          limit 1
       ), 0)
  from consignment_lot_consumption c
 where c.settlement_document_id is not null
   and not exists (
         select 1 from consignment_settlement_line sl
          where sl.consumption_id = c.id
            and sl.settlement_document_id = c.settlement_document_id
       );

-- What is still owed on consigned goods that have sold: consumed, and with no
-- settlement standing against them. A voided settlement leaves its row here
-- and stops counting, which is what makes the sale re-settleable.
create or replace view v_consignment_unsettled as
select c.company_id,
       c.id as consumption_id,
       c.delivery_document_id,
       c.lot_id,
       c.qty,
       cl.item_id,
       rd.partner_id as consignor_id
  from consignment_lot_consumption c
  join consignment_lot cl on cl.id = c.lot_id
  join document rd on rd.id = cl.receipt_document_id
 where not exists (
         select 1
           from consignment_settlement_line sl
           join document sd on sd.id = sl.settlement_document_id
          where sl.consumption_id = c.id
            and sd.status = 'POSTED'
       );

comment on view v_consignment_unsettled is
    'Consigned goods that have been delivered and have no settlement standing '
    'against them — never settled, or settled by a document since voided.';
