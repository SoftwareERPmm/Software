-- 0065_a_closure_remembers_what_had_arrived.sql
-- What an order had received, or delivered, at the moment it was closed.
--
-- Closing an order and cancelling one are the same act to the database — a
-- row in order_closure saying the rest is not expected — but they are not the
-- same thing to read back. An order closed with nothing received was
-- cancelled outright; one closed with forty of a hundred received had its
-- remainder closed, and the forty still happened. The screens want to say
-- which, and the reason field cannot be trusted to: it is free text.
--
-- Deriving it from today's fulfilment is the trap. Fulfilment is not fixed
-- after the fact — a receipt can be returned, a delivery reversed, a
-- correction can restate the quantity on the very order that was closed. An
-- order cancelled with nothing received, then given a receipt linked to it
-- later, would silently rewrite its own history and start reading as a
-- remainder closure. The distinction is about a moment, so it has to be
-- recorded at that moment rather than recomputed from a world that has moved
-- on since.
--
-- Both figures, not just one. Fulfilled says which kind of closure this was;
-- outstanding says how much was given up, which is what the confirmation
-- promised the person clicking it and what they will look for afterwards.

alter table order_closure
    add column if not exists fulfilled_at_closure   numeric(18,4),
    add column if not exists outstanding_at_closure numeric(18,4);

-- Deliberately nullable, and deliberately not backfilled.
--
-- Rows written before this migration have no snapshot, and there is no honest
-- way to invent one: today's fulfilment is exactly the figure that cannot be
-- trusted to say what was true then. Null means "not recorded", and the
-- screens must read it as unknown rather than as zero — zero would label
-- every closure made before today as an outright cancellation, which is a
-- confident claim drawn from missing data.
comment on column order_closure.fulfilled_at_closure is
    'How much of the order had been received (purchase) or delivered (sales) '
    'when this closure was written. Null on rows predating the column: not '
    'recorded, and not to be read as zero. Zero means the order was '
    'cancelled outright; above zero means its remainder was closed.';

comment on column order_closure.outstanding_at_closure is
    'How much was still expected when this closure was written -- what the '
    'closure gave up. Null on rows predating the column.';
