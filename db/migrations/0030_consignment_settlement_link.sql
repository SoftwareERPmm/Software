-- 0030_consignment_settlement_link.sql
-- Fixes a self-contradiction from the previous migration, caught by
-- actually running the sale-side code against it rather than by reading it.
--
-- consignment_lot_consumption was made fully append-only in 0028 - no
-- update, ever - but its own settlement_document_id column is designed to
-- be filled in LATER: a consumption row is written at delivery with it
-- null, and settleConsignmentSales sets it once the sales invoice that
-- settles it posts. The trigger refused that legitimate write the moment
-- the code that needed it actually ran.
--
-- Fixed the same way document/document_line handle their own one-time
-- transition (0023): exactly one change is permitted - settlement_document_id
-- going from null to a value, nothing else on the row moving - and refused
-- ever after, including a second attempt to set it. Everything else about
-- the row (lot_id, delivery_document_id, qty) stays frozen from the moment
-- it is written, same as before.

create or replace function fn_consignment_lot_consumption_immutable() returns trigger
language plpgsql as $$
begin
    if (TG_OP = 'DELETE') then
        raise exception 'Consignment lot consumption is append-only. Post a reversing movement instead.';
    end if;

    if OLD.settlement_document_id is null
       and NEW.settlement_document_id is not null
       and NEW.id                     is not distinct from OLD.id
       and NEW.company_id             is not distinct from OLD.company_id
       and NEW.lot_id                 is not distinct from OLD.lot_id
       and NEW.delivery_document_id   is not distinct from OLD.delivery_document_id
       and NEW.qty                    is not distinct from OLD.qty
       and NEW.created_at             is not distinct from OLD.created_at
    then
        return NEW;
    end if;

    raise exception 'Consignment lot consumption is append-only. Post a reversing movement instead.';
end;
$$;
