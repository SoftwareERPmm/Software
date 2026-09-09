-- Opening balances are not a way into a subledger-owned account.
--
-- 0045 exempted OPENING_BALANCE from the subledger rule, reasoning that
-- opening figures are how inventory and receivables get their starting
-- balances and no operational document could produce them. The first half is
-- true. The second is not, and the exemption opened exactly the hole 0045 was
-- written to close:
--
--     Dr Inventory 1,000,000 / Cr Opening Balance Equity 1,000,000
--
-- balances perfectly, posts, and moves no stock. Measured on 2026-09-07:
-- general ledger inventory 1,077,000 against a stock ledger of 77,000, and
-- check.mjs went from zero reconciliation breaks to one. The same route was
-- open to GR/IR, where an opening balance would assert goods received and
-- not yet billed with no receipt behind it.
--
-- The exemption is not needed. Opening stock is entered as stock — a goods
-- receipt or a stock adjustment carrying quantity, warehouse and unit cost —
-- which writes the stock ledger and the general ledger together and leaves
-- FIFO layers a later sale can consume. A journal line cannot do any of that;
-- it can only make the two disagree.
--
-- Receivables and payables were never actually reachable this way: the guard
-- requires a partner on every control-account line and postAccountOpening
-- writes none, so those refused already. That protection stays.
--
-- What remains for a manual opening balance is everything a subledger does
-- not own: cash, bank, fixed assets, accruals, loans, capital, retained
-- earnings. That is the whole legitimate use.

create or replace function fn_journal_line_account_guard() returns trigger
language plpgsql as $$
declare
    a account;
    e journal_entry;
    owner text;
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

    -- A subledger-owned balance may only be moved by the transaction that
    -- owns it. Opening balances are included: an opening figure for a
    -- subledger account has to arrive through the subledger, or the two
    -- start out disagreeing and every report built on them inherits it.
    if a.subledger is not null
       and (e.source_type is null
            or e.source_type in ('JOURNAL_VOUCHER', 'CASH_VOUCHER', 'BANK_VOUCHER',
                                 'OPENING_BALANCE'))
    then
        owner := case a.subledger
            when 'CUSTOMER' then
                'the customer subledger. Raise a sales invoice, customer return '
                || 'or customer receipt instead'
            when 'SUPPLIER' then
                'the supplier subledger. Raise a purchase invoice, supplier return '
                || 'or supplier payment instead'
            when 'INVENTORY' then
                'the inventory subledger. Opening stock is entered as stock — a '
                || 'goods receipt or a stock adjustment with quantity, warehouse '
                || 'and unit cost — so the stock ledger moves with the balance'
            when 'PURCHASE_MATCHING' then
                'goods receipt and invoice matching. It clears when the bill for a '
                || 'receipt arrives, and is not posted to by hand'
        end;
        raise exception
            'Account % (%) is maintained by %', a.code, a.name, owner;
    end if;

    -- Control accounts additionally need to say whose balance moved, or the
    -- subledger cannot be reconciled back to them line by line.
    if a.is_control and new.partner_id is null then
        raise exception
            'Control account % requires partner_id on the line', a.code;
    end if;

    return new;
end;
$$;
