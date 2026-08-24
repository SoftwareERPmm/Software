-- 0027_company_isolation.sql
-- Every row a posting touches must belong to the company posting it.
--
-- journal_line carries company_id, and account carries company_id, and
-- nothing compared the two. The account guard checked that an account was
-- postable, active, currency-compatible and not a control account being
-- reached by a manual entry - a careful set of checks, all about the account
-- in isolation, none about whose account it was. So a voucher for company A
-- could name company B's cash account and post:
--
--   account 6100   amount   50000   line company A   account company A
--   account 1110   amount  -50000   line company A   account company B
--
-- Company A's entry balances. Company A's trial balance is fine. Company B,
-- which did not transact, is now 50,000 out - and nothing in B's books says
-- where it came from, because the journal entry belongs to A.
--
-- fn_stock_location_guard had the same shape: it checked that a location
-- holds stock and an item is stocked, never that either belonged to the
-- company moving them.
--
-- Not reachable through the application today, which serves one company and
-- resolves accounts from that company's posting rules. It is reachable by
-- anything else that calls the posting engine, and it is exactly the
-- invariant that has to already be true before a second company is ever
-- added - by which time there would be real books on both sides of it.
--
-- Both guards also now fail when the referenced row does not exist at all.
-- Before, a missing row left every field null, every `if not ...` test
-- evaluated to null rather than true, and the trigger fell through and
-- allowed the write. Foreign keys caught it a moment later, but on the
-- strength of a different constraint than the one meant to be checking.

create or replace function fn_journal_line_account_guard() returns trigger
language plpgsql as $$
declare
    a account;
    e journal_entry;
begin
    select * into a from account where id = new.account_id;
    if not found then
        raise exception 'Account % does not exist', new.account_id;
    end if;

    select * into e from journal_entry where id = new.journal_entry_id;
    if not found then
        raise exception 'Journal entry % does not exist', new.journal_entry_id;
    end if;

    -- A line, its entry and its account are three references to one company.
    -- If they disagree, one company's ledger is carrying another's balance.
    if new.company_id <> e.company_id then
        raise exception
            'Journal line belongs to a different company than entry %', e.entry_no;
    end if;

    if a.company_id <> new.company_id then
        raise exception
            'Account % (%) belongs to another company and cannot be posted to here',
            a.code, a.name;
    end if;

    if not a.is_postable then
        raise exception
            'Account % (%) is a heading and cannot be posted to', a.code, a.name;
    end if;

    if not a.is_active then
        raise exception 'Account % (%) is inactive', a.code, a.name;
    end if;

    if a.currency is not null and a.currency <> new.currency then
        raise exception
            'Account % is denominated in % but the line is in %',
            a.code, a.currency, new.currency;
    end if;

    -- Control accounts belong to their subledger. A hand-typed journal entry
    -- posting straight to AR is how a subledger silently stops reconciling.
    if a.is_control then
        if e.source_type is null then
            raise exception
                'Account % is a control account and cannot be posted to by a manual journal entry',
                a.code;
        end if;
        if new.partner_id is null then
            raise exception
                'Control account % requires partner_id on the line', a.code;
        end if;
    end if;

    return new;
end;
$$;

create or replace function fn_stock_location_guard() returns trigger
language plpgsql as $$
declare
    l location;
    i item;
begin
    select * into l from location where id = new.location_id;
    if not found then
        raise exception 'Location % does not exist', new.location_id;
    end if;
    if l.company_id <> new.company_id then
        raise exception
            'Location % (%) belongs to another company', l.code, l.name;
    end if;
    if not l.is_stock_location then
        raise exception
            'Location % (%) is not a stock location', l.code, l.name;
    end if;

    select * into i from item where id = new.item_id;
    if not found then
        raise exception 'Item % does not exist', new.item_id;
    end if;
    if i.company_id <> new.company_id then
        raise exception
            'Item % (%) belongs to another company', i.code, i.name;
    end if;
    if not i.is_stocked then
        raise exception
            'Item % (%) is not stocked and cannot have movements', i.code, i.name;
    end if;

    return new;
end;
$$;

comment on function fn_journal_line_account_guard is
    'A journal line, its entry and its account must all name one company. '
    'Anything else lets one company post into another company''s account, '
    'balanced on the posting side and unexplained on the receiving one.';
