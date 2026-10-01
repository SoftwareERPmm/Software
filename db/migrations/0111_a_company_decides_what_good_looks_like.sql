-- A company decides what good looks like, and which five things it watches.
--
-- Supplier performance shipped with illustrative defaults: a lead-time CV
-- limit of 0.5, a 20% price premium ceiling, a 90% on-time target. Every one
-- of them is a guess made by whoever wrote the code, and a guess is fine as
-- a starting point and indefensible as a permanent answer — the buyer
-- arguing with a supplier needs the number to be one their own business
-- chose.
--
-- Two tables, because they answer two different questions
-- --------------------------------------------------------
-- A **target** is what the business wants: "we expect 95% fulfilment". Move
-- it and nothing about history changes, only the line drawn beside the
-- figure. A **normalization boundary** is what maps a measurement onto the
-- 0-100 axis; move that and every chart ever drawn is redrawn. Keeping them
-- in one column called "threshold" is how a company ends up quietly
-- rewriting its own past by raising an ambition, so they are separate
-- fields in one settings row and the settings page says which is which.
--
-- A **preset** is a different question again: not what good looks like, but
-- which axes this company cares to look at. Purchasing and quality want
-- different charts from the same data, and both are right.
--
-- Why jsonb and not columns per metric
-- -------------------------------------
-- Enterprise is meant to add its own metrics later, and a column per metric
-- means a migration per metric — a schema change to add a number to a
-- settings page. The shape is validated in lib/supplier-metrics.ts, which
-- is where the metrics are declared, so the database storing an object it
-- does not interpret is honest rather than lazy: it genuinely does not know
-- what a CV limit is, and pretending otherwise buys nothing.
--
-- Nothing here is read by posting, valuation or any document. These rows
-- change how a chart is drawn and nothing else.

create table if not exists supplier_performance_setting (
    company_id  uuid primary key references company(id) on delete cascade,

    /** Normalization boundaries: what maps a measurement to 0-100.
     *  Keys are Thresholds in lib/supplier-metrics.ts. */
    thresholds  jsonb not null default '{}'::jsonb,

    /** Business targets: what the company wants to see. Keys are metric
     *  ids. Deliberately a separate column from thresholds — see above. */
    targets     jsonb not null default '{}'::jsonb,

    /** Which rules produced figures stored or exported under these
     *  settings, so a change of formula is visible rather than silent. */
    calc_version int not null default 1,

    updated_at  timestamptz not null default now(),
    updated_by  text
);

comment on table supplier_performance_setting is
    'One row per company. thresholds are the 0-100 scale; targets are what '
    'the business wants to hit. Moving a target never redraws history, '
    'moving a threshold always does.';

create table if not exists supplier_radar_preset (
    id          uuid primary key default gen_random_uuid(),
    company_id  uuid not null references company(id) on delete cascade,

    name        text not null check (length(btrim(name)) > 0),

    /** Metric ids in the order they appear on the chart. Order is part of
     *  the preset: a radar's shape changes entirely with the order of its
     *  axes, so two people comparing charts need the same sequence. */
    axes        jsonb not null,

    /** The one that opens by default. Enforced to at most one per company
     *  by the partial unique index below rather than by hoping. */
    is_default  boolean not null default false,

    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    created_by  text,

    unique (company_id, name),

    /** Three is the fewest that has a shape, six the most that fits before
     *  the labels collide. The same bounds the picker enforces, repeated
     *  here because the application is not the only writer. */
    constraint supplier_radar_preset_axis_count
        check (jsonb_typeof(axes) = 'array'
               and jsonb_array_length(axes) between 3 and 6)
);

create unique index if not exists supplier_radar_preset_one_default
    on supplier_radar_preset (company_id) where is_default;

comment on table supplier_radar_preset is
    'A named set of three to six radar axes, in order. Presets are a view '
    'of the same measurements, never a different calculation of them.';
