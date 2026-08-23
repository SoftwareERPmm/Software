-- 0022_posting_rule_audit.sql
-- An audit trail over the two tables that decide where money lands.
--
-- account_determination and system_account are executable financial policy:
-- repoint INVENTORY from "Inventory - Trading Goods" to "Marketing Expense"
-- and every subsequent goods receipt still balances perfectly, still passes
-- every invariant in this schema, and is still completely wrong. Nothing
-- recorded that the rule had changed, so the only way to notice was to read
-- the chart of accounts and know what it should have said.
--
-- What was already safe, and is not the problem this solves: journal_line
-- stores the *resolved* account_id, frozen at posting time. Changing a rule
-- never rewrites history — postings made before the change keep the account
-- they actually used. The gap was only ever forward-looking and undocumented.
--
-- Enforced with a trigger rather than in the application, because neither
-- table is editable through the UI. A change to them arrives over psql or a
-- script, which application code is in no position to intercept.

create table posting_rule_change (
    id            uuid primary key default gen_random_uuid(),
    company_id    uuid,

    source_table  text not null check (source_table in ('account_determination', 'system_account')),
    operation     text not null check (operation in ('INSERT', 'UPDATE', 'DELETE')),

    role          text,

    -- Which rule, for account_determination. All null on system_account,
    -- which is keyed by role alone.
    item_group_id uuid,
    partner_id    uuid,
    location_id   uuid,

    -- The point of the record: what money used to hit, and what it hits now.
    -- Codes as well as ids, so the log stays readable after an account is
    -- renamed, and survives the account row being deleted entirely.
    old_account_id   uuid,
    old_account_code text,
    old_account_name text,
    new_account_id   uuid,
    new_account_code text,
    new_account_name text,

    -- No authentication exists yet, so app_user is null for now. The column
    -- is here so that when it does, the app can `set local app.user_id` in
    -- the transaction and this fills itself in with no further migration.
    app_user      text,
    db_user       text not null default current_user,
    changed_at    timestamptz not null default now()
);

create index on posting_rule_change (company_id, changed_at desc);
create index on posting_rule_change (source_table, role);

comment on table posting_rule_change is
    'Every change to a posting rule. These tables decide which GL account a '
    'document posts to, so a change to them is a change to financial policy: '
    'it stays balanced and passes every invariant while being wrong. '
    'Written by trigger, never by the application.';

-- Resolves an account to code and name so the log reads without a join, and
-- keeps meaning if the account is later renamed or removed.
create or replace function fn_account_label(p_account uuid)
returns table (code text, name text) language sql stable as $$
    select a.code, a.name from account a where a.id = p_account;
$$;

create or replace function fn_log_posting_rule_change() returns trigger
language plpgsql as $$
declare
    v_old_code text; v_old_name text;
    v_new_code text; v_new_name text;
    v_company  uuid;
    v_role     text;
    v_group    uuid;
    v_partner  uuid;
    v_location uuid;
    v_old_acct uuid;
    v_new_acct uuid;
begin
    if (TG_OP = 'DELETE') then
        v_company := OLD.company_id;
        v_role    := OLD.role;
        v_old_acct := OLD.account_id;
    else
        v_company := NEW.company_id;
        v_role    := NEW.role;
        v_new_acct := NEW.account_id;
        if (TG_OP = 'UPDATE') then
            v_old_acct := OLD.account_id;
        end if;
    end if;

    -- Only account_determination carries match criteria; system_account is
    -- keyed by role alone, so these stay null there.
    if (TG_TABLE_NAME = 'account_determination') then
        if (TG_OP = 'DELETE') then
            v_group := OLD.item_group_id; v_partner := OLD.partner_id; v_location := OLD.location_id;
        else
            v_group := NEW.item_group_id; v_partner := NEW.partner_id; v_location := NEW.location_id;
        end if;
    end if;

    select code, name into v_old_code, v_old_name from fn_account_label(v_old_acct);
    select code, name into v_new_code, v_new_name from fn_account_label(v_new_acct);

    -- An update that does not move the account is not a policy change.
    if (TG_OP = 'UPDATE' and v_old_acct is not distinct from v_new_acct) then
        return NEW;
    end if;

    insert into posting_rule_change (
        company_id, source_table, operation, role,
        item_group_id, partner_id, location_id,
        old_account_id, old_account_code, old_account_name,
        new_account_id, new_account_code, new_account_name,
        app_user
    ) values (
        v_company, TG_TABLE_NAME, TG_OP, v_role,
        v_group, v_partner, v_location,
        v_old_acct, v_old_code, v_old_name,
        v_new_acct, v_new_code, v_new_name,
        nullif(current_setting('app.user_id', true), '')
    );

    return coalesce(NEW, OLD);
end;
$$;

create trigger trg_log_account_determination
    after insert or update or delete on account_determination
    for each row execute function fn_log_posting_rule_change();

create trigger trg_log_system_account
    after insert or update or delete on system_account
    for each row execute function fn_log_posting_rule_change();

-- The log is evidence, so it is append-only like the ledger it protects.
create or replace function fn_posting_rule_change_immutable() returns trigger
language plpgsql as $$
begin
    raise exception 'posting_rule_change is append-only; a rule change cannot be edited or erased';
end;
$$;

create trigger trg_posting_rule_change_immutable
    before update or delete on posting_rule_change
    for each row execute function fn_posting_rule_change_immutable();
