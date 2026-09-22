-- A tax rate belongs to a date, not to a code.
--
-- Commercial tax rates change by notification, part-way through a year. With
-- the rate kept on the code itself the only way to follow that was to edit
-- it, which is a forward-only act with a backward-looking name: the code
-- called "5%" would go on saying 5% about every invoice it had ever been
-- used on, while charging 6% on the next one. Nothing posted moved — the tax
-- is stored on the line — but the master data stopped describing the history
-- it was attached to.
--
-- So a code now owns a series of rates, each effective from a date, the same
-- shape volume_discount and item_price already use. Posting resolves the
-- rate for the document's own date, which also means a backdated invoice is
-- taxed the way that day was taxed rather than the way today is.

create table if not exists tax_rate (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references company(id) on delete cascade,
  tax_code_id   uuid not null references tax_code(id) on delete cascade,
  rate          numeric(9,6) not null check (rate >= 0 and rate <= 100),
  valid_from    date not null,
  created_at    timestamptz not null default now(),
  -- One rate per code per day. Two rates starting the same morning is not a
  -- schedule, it is a question nobody can answer.
  unique (tax_code_id, valid_from)
);

create index if not exists ix_tax_rate_lookup on tax_rate (tax_code_id, valid_from desc);

-- What each code charges today becomes its opening rate, effective from
-- before any document this company could hold. Every invoice already posted
-- keeps its own stored tax regardless; this is so that re-posting or
-- amending an old document resolves the same rate it was raised at.
insert into tax_rate (company_id, tax_code_id, rate, valid_from)
select t.company_id, t.id, t.rate, date '1900-01-01'
  from tax_code t
 where not exists (
   select 1 from tax_rate r where r.tax_code_id = t.id
 );

/*
 * The rate a code charges on a given day: the latest one that had started by
 * then. Null when the code had no rate yet, which the engine refuses on
 * rather than treating as zero — a tax nobody has set a rate for is an
 * unanswered question, not an exemption.
 */
create or replace function fn_tax_rate_on(p_tax_code_id uuid, p_on date)
returns numeric
language sql
stable
as $$
  select r.rate
    from tax_rate r
   where r.tax_code_id = p_tax_code_id
     and r.valid_from <= p_on
   order by r.valid_from desc
   limit 1
$$;

-- One source of truth. The column stays only as long as it takes to stop
-- reading it, and this migration is that moment.
alter table tax_code drop column if exists rate;
