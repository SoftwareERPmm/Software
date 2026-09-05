-- Rebuild every daily counter from the numbers actually issued.
--
-- 0038 merged the old type-keyed series onto the prefix key, and picked the
-- rows to merge with `document_type like '%\_%'` — on the assumption that an
-- old key looked like CASH_VOUCHER or CASH_VOUCHER:IN. JOURNAL has no
-- underscore, so its counter was left behind, a fresh JE counter started at
-- one, and the next journal entry collided with one already issued.
--
-- Guessing which rows needed merging was the mistake. The counters do not
-- have to be inferred at all: what has been issued is written on the
-- documents and the journal entries themselves, and that is the only source
-- that cannot be out of step with reality. So every dated counter is
-- recomputed from the highest number actually in use for that prefix and
-- date, whatever shape its key was in before.

-- Everything dated goes; each is rebuilt below from what was really issued.
delete from number_series where series_date is not null;

-- Numbers look like <prefix><YYYYMMDD><sequence>, where the prefix is
-- letters and the rest is exactly 8 digits of date followed by the count.
-- Anything not of that shape is a pre-0035 number and is deliberately not
-- counted here — those belong to the old per-fiscal-year series, which is
-- untouched.
insert into number_series (company_id, document_type, series_date, prefix, padding, next_value)
select company_id, pfx, dt, pfx, 3, max(seq) + 1
  from (
    select d.company_id,
           substring(d.doc_no from '^([A-Z]+)') as pfx,
           to_date(substring(d.doc_no from '^[A-Z]+(\d{8})'), 'YYYYMMDD') as dt,
           substring(d.doc_no from '^[A-Z]+\d{8}(\d+)$')::bigint as seq
      from document d
     where d.doc_no ~ '^[A-Z]+\d{8}\d+$'
    union all
    select je.company_id,
           substring(je.entry_no from '^([A-Z]+)'),
           to_date(substring(je.entry_no from '^[A-Z]+(\d{8})'), 'YYYYMMDD'),
           substring(je.entry_no from '^[A-Z]+\d{8}(\d+)$')::bigint
      from journal_entry je
     where je.entry_no ~ '^[A-Z]+\d{8}\d+$'
  ) issued
 group by company_id, pfx, dt;
