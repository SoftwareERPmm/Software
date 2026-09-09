-- A cutover may open a subledger, because it opens the subledger too.
--
-- 0046 stopped opening balances reaching subledger-owned accounts, because a
-- typed figure moved the general ledger and nothing else: inventory value
-- with no stock behind it. That rule is right and stays.
--
-- What it also caught, correctly by its own terms, is the cutover itself.
-- postOpeningBatch writes the stock movement, the FIFO layer and the journal
-- line in one transaction, and writes receivables as open items carrying the
-- customer's own reference and due date. It is the one thing that does move
-- both ledgers together, which is exactly what the rule is protecting.
--
-- So the exemption is not "opening balances" — that was 0045's mistake, too
-- broad by half. It is documents belonging to an opening batch. Nothing else
-- can set opening_batch_id: postOpeningBatch creates the batch row and the
-- documents in the same transaction, and a unique index allows one posted
-- batch per company. A second cutover cannot be posted, so this cannot be
-- used twice.

create or replace function fn_journal_line_account_guard() returns trigger
language plpgsql as $$
declare
    a account;
    e journal_entry;
    owner text;
    from_cutover boolean;
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

    select d.opening_batch_id is not null into from_cutover
      from document d where d.id = e.source_id;

    -- A subledger-owned balance may only be moved by something that moves the
    -- subledger with it. The cutover does; a hand-typed voucher or opening
    -- balance does not.
    if a.subledger is not null
       and not coalesce(from_cutover, false)
       and (e.source_type is null
            or e.source_type in ('JOURNAL_VOUCHER', 'CASH_VOUCHER', 'BANK_VOUCHER',
                                 'OPENING_BALANCE'))
    then
        owner := case a.subledger
            when 'CUSTOMER' then
                'the customer subledger. Raise a sales invoice, customer return '
                || 'or customer receipt instead, or enter it in the opening setup'
            when 'SUPPLIER' then
                'the supplier subledger. Raise a purchase invoice, supplier return '
                || 'or supplier payment instead, or enter it in the opening setup'
            when 'INVENTORY' then
                'the inventory subledger. Opening stock is entered in the opening '
                || 'setup, and stock afterwards moves on a goods receipt, delivery, '
                || 'adjustment or transfer — so the stock ledger moves with it'
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
