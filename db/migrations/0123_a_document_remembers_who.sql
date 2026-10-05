-- A document remembers who made it, and managers hear about it.
--
-- document.created_by_id and posted_by_id have existed since 0052 and the
-- document page has always read them. Nothing ever wrote them: there was
-- nobody signed in to name. Now there is.
--
-- Filled here, by trigger, rather than by each of the twenty-odd posting
-- functions. lib/db.ts stamps every transaction a signed-in request opens
-- with set_config('app.user_id', …, true) — local to that transaction, so a
-- pooled connection can never carry one person's name into another's work —
-- and every document inserted inside it picks the name up. A script or test
-- runs with no stamp and leaves the columns empty, which is the truth: no
-- person did it.
--
-- The same for document_history, whose acted_by has been waiting since 0037.

create or replace function fn_current_app_user() returns uuid
language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

create or replace function fn_document_attribution() returns trigger
language plpgsql as $$
begin
    new.created_by_id := coalesce(new.created_by_id, fn_current_app_user());
    if new.status = 'POSTED' then
        new.posted_by_id := coalesce(new.posted_by_id, fn_current_app_user());
    end if;
    return new;
end;
$$;

drop trigger if exists trg_document_attribution on document;
create trigger trg_document_attribution
    before insert on document
    for each row execute function fn_document_attribution();

create or replace function fn_document_history_attribution() returns trigger
language plpgsql as $$
begin
    new.acted_by := coalesce(new.acted_by, fn_current_app_user());
    return new;
end;
$$;

drop trigger if exists trg_document_history_attribution on document_history;
create trigger trg_document_history_attribution
    before insert on document_history
    for each row execute function fn_document_history_attribution();

-- The bell. Null means "whatever this person's role starts with": on for
-- Admin and Manager, off for everyone else. Seen-at is how far down the
-- feed they have read.
alter table app_user add column if not exists notifications_on boolean;
alter table app_user add column if not exists notifications_seen_at timestamptz;

-- The feed reads recent documents newest first, by company.
create index if not exists document_company_created_idx
    on document (company_id, created_at desc);
