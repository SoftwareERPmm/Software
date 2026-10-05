-- People sign in, and what they can do depends on the roles they hold.
--
-- app_user has been here since 0052, waiting: documents already point at it
-- for who created and who posted them, and its comment said this is what a
-- login would attach to. This adds the login.
--
-- Roles are a set, not one value. A small trading company has the same
-- person raising invoices in the morning and receiving stock in the
-- afternoon; one role per person would force either a second account or a
-- role broader than the job.
--
--   ADMIN       everything, and managing who can sign in
--   MANAGER     everything except managing users
--   SALES       sales, receivables, logistics
--   PURCHASING  purchases, payables
--   INVENTORY   stock, items, warehouses, deliveries and receipts
--   ACCOUNTING  cash and bank, journals, ledgers, reports
--
-- What each role reaches is decided in lib/auth.ts, in one table, and
-- enforced twice: on every page by middleware, and on every server action.

alter table app_user add column if not exists password_hash text;
alter table app_user add column if not exists roles text[] not null default '{}';
alter table app_user add column if not exists must_change_password boolean not null default false;
alter table app_user add column if not exists last_login_at timestamptz;
alter table app_user add column if not exists failed_logins integer not null default 0;
alter table app_user add column if not exists locked_until timestamptz;

alter table app_user drop constraint if exists app_user_roles_check;
alter table app_user add constraint app_user_roles_check check (
  roles <@ array['ADMIN','MANAGER','SALES','PURCHASING','INVENTORY','ACCOUNTING']::text[]
);

-- An email signs in, so it names one person.
create unique index if not exists app_user_email_unique
    on app_user (lower(email)) where email is not null;

-- A session is a random token held in a cookie. Only its hash is stored, so
-- reading this table does not let anyone sign in as anybody.
create table if not exists app_session (
    id           uuid primary key default gen_random_uuid(),
    token_hash   text not null unique,
    user_id      uuid not null references app_user(id) on delete cascade,
    created_at   timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    expires_at   timestamptz not null
);
create index if not exists app_session_user_idx on app_session (user_id);

comment on table app_user is
    'A person who signs in. Roles decide what they can reach — see lib/auth.ts.';
comment on table app_session is
    'Signed-in sessions. token_hash is sha256 of the cookie value; the value itself is never stored.';
