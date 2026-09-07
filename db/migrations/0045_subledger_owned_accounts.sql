-- Manual vouchers must not move a balance that a subledger owns.
--
-- `is_control` was carrying two jobs it cannot do at once. It means "this
-- account needs a partner on every line", which is true of AR and AP, and it
-- was also being used as the boundary for "a hand-typed journal cannot touch
-- this". Inventory and GR/IR are not control accounts — no partner belongs on
-- an inventory line — but they are every bit as subledger-owned, and nothing
-- stopped a journal voucher from posting to them.
--
-- Probed on 2026-09-07, all three posted with no complaint:
--
--     Dr Inventory / Cr Owner's Capital     -> stock ledger unchanged, so the
--                                              inventory reconciliation broke
--     Dr GR/IR / Cr Owner's Capital         -> a matching balance with no
--                                              receipt or invoice behind it
--     Dr AR / Cr Sales                      -> refused, but only because of
--                                              the partner_id rule below
--
-- The last one matters most. The rule meant to stop it reads
-- `if a.is_control and e.source_type is null`, and a journal voucher's entry
-- carries source_type 'JOURNAL_VOUCHER', never null — so that branch has
-- never once fired for the thing it was written to stop. What actually
-- refused the posting was the partner requirement, and only because
-- VoucherInput has no partnerId field to supply. Add one, which is a
-- reasonable thing to want, and direct AR posting starts working silently.
--
-- So: name the owner, and key the rule on where the entry came from.

alter table account
    add column if not exists subledger text
        check (subledger in ('CUSTOMER', 'SUPPLIER', 'INVENTORY', 'PURCHASE_MATCHING'));

comment on column account.subledger is
    'Which subledger owns this balance, or null if a manual voucher may post '
    'to it freely. Separate from is_control, which only says a partner is '
    'required: inventory is owned but takes no partner.';

-- Backfill from the roles the posting engine resolves, never from account
-- codes. The codes differ per chart — 1300 is Inventory on the demo chart and
-- Software on the customer's — and a backfill keyed on them would flag the
-- wrong accounts on one of the two.
update account a set subledger = 'CUSTOMER'
  from account_determination d
 where d.account_id = a.id and d.role = 'AR_CONTROL' and a.subledger is null;

update account a set subledger = 'SUPPLIER'
  from account_determination d
 where d.account_id = a.id and d.role = 'AP_CONTROL' and a.subledger is null;

-- Every account any item group resolves INVENTORY to, not just the
-- company-wide default: a per-group override is still inventory.
update account a set subledger = 'INVENTORY'
  from account_determination d
 where d.account_id = a.id and d.role = 'INVENTORY' and a.subledger is null;

update account a set subledger = 'PURCHASE_MATCHING'
  from system_account s
 where s.account_id = a.id and s.role = 'GRIR_CLEARING' and a.subledger is null;

-- A control account nothing above caught is still owned by whichever side its
-- type puts it on. Belt and braces for a chart that maps roles unusually.
update account set subledger = case when account_type = 'ASSET' then 'CUSTOMER' else 'SUPPLIER' end
 where is_control and subledger is null;

create index if not exists account_subledger_idx on account (company_id, subledger)
    where subledger is not null;

-- The guard, rewritten whole from the definition currently installed rather
-- than from an older migration file. Rebuilding one of these from a stale
-- copy is how 0037 silently dropped 0028's consignment branch and left posted
-- consignment receipts editable until 0041 put it back.
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
    -- owns it. Keyed on where the entry came from: the three voucher types
    -- are free-form entry against arbitrary accounts, and an entry with no
    -- source at all is hand-written straight into the ledger.
    --
    -- OPENING_BALANCE is deliberately exempt. Opening figures are precisely
    -- how inventory and receivables get their starting balances, and there is
    -- no operational document that could produce them.
    if a.subledger is not null
       and (e.source_type is null
            or e.source_type in ('JOURNAL_VOUCHER', 'CASH_VOUCHER', 'BANK_VOUCHER'))
    then
        owner := case a.subledger
            when 'CUSTOMER' then
                'the customer subledger. Raise a sales invoice, customer return '
                || 'or customer receipt instead'
            when 'SUPPLIER' then
                'the supplier subledger. Raise a purchase invoice, supplier return '
                || 'or supplier payment instead'
            when 'INVENTORY' then
                'the inventory subledger. Post a goods receipt, delivery, stock '
                || 'adjustment or transfer instead, so the stock ledger moves with it'
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

comment on function fn_journal_line_account_guard is
    'Refuses a journal line that a document should have written: a heading, an '
    'inactive or foreign account, a subledger-owned balance moved by a manual '
    'voucher, or a control account with no partner named.';
