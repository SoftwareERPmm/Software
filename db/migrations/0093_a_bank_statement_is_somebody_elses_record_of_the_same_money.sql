-- A bank statement is somebody else's record of the same money.
--
-- The ledger says what we think happened to the bank account. The statement
-- says what the bank thinks. Reconciliation is the act of putting the two
-- lists side by side and accounting for every line that appears on one and
-- not the other — a cheque written but not yet presented, a bank charge
-- nobody told us about, a customer transfer that arrived without a
-- reference.
--
-- Nothing here posts, and nothing here touches journal_line.
--
-- That last point is the whole design. The obvious implementation is a
-- `reconciled` flag on the ledger line, and it is wrong for this codebase:
-- journal_line is written in exactly one place, and a second writer — even
-- one setting a harmless boolean — makes "who last wrote to the ledger" a
-- question with two answers. So a match is its own row joining the two
-- sides, the ledger stays append-only and owned by lib/posting.ts, and
-- unreconciling is deleting a match rather than editing history.
--
-- A bank charge found on the statement and missing from the books is not
-- reconciled by typing it here. It is a real transaction and wants a real
-- bank payment voucher, which posts; the match then points at that voucher's
-- own journal line like any other.

-- --------------------------------------------------------- the statement ---

create table if not exists bank_statement (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references company(id) on delete cascade,
  -- Which bank account this is a statement of. Not nullable: a statement
  -- that does not say which account it belongs to cannot be compared with
  -- anything.
  account_id       uuid not null references account(id),
  statement_no     text not null,
  from_date        date not null,
  to_date          date not null,
  -- What the bank says the account held at each end. Optional, because not
  -- every export carries them — but when they are present they are the only
  -- independent check that the imported lines are complete.
  opening_balance  numeric(18,4),
  closing_balance  numeric(18,4),
  filename         text,
  status           text not null default 'OPEN'
                   check (status in ('OPEN','RECONCILED')),
  created_at       timestamptz not null default now(),
  unique (company_id, statement_no),
  constraint bank_statement_dates check (to_date >= from_date)
);

create index if not exists ix_bank_statement_account
  on bank_statement (company_id, account_id, to_date desc);

-- One line as the bank printed it. Kept verbatim: the description is how a
-- human recognises a payment six weeks later, and rewriting it to something
-- tidier loses the only clue.
create table if not exists bank_statement_line (
  id             uuid primary key default gen_random_uuid(),
  statement_id   uuid not null references bank_statement(id) on delete cascade,
  line_no        integer not null,
  txn_date       date not null,
  description    text,
  reference      text,
  -- Signed from the account's point of view: money in is positive, money out
  -- is negative. One signed column rather than paid-in/paid-out, because
  -- every import format disagrees about which column is which and a sign is
  -- unambiguous once resolved.
  amount         numeric(18,4) not null,
  -- Running balance as printed, where the export gives one.
  balance        numeric(18,4),
  -- IGNORED is for a line that is genuinely not ours to match — an opening
  -- balance row, a header the parser kept. It needs a reason, so that
  -- "ignored" never becomes a quiet way to make a statement balance.
  status         text not null default 'UNMATCHED'
                 check (status in ('UNMATCHED','MATCHED','IGNORED')),
  ignore_reason  text,
  created_at     timestamptz not null default now(),
  unique (statement_id, line_no),
  constraint bank_statement_line_ignored_says_why
    check (status <> 'IGNORED' or coalesce(btrim(ignore_reason), '') <> '')
);

create index if not exists ix_bank_statement_line_match
  on bank_statement_line (statement_id, status, txn_date);

-- ------------------------------------------------------------ the match ---

-- One statement line against one ledger line.
--
-- Deliberately one-to-one in both directions. A lump bank credit covering
-- three invoices is, in this system, already one receipt voucher with one
-- bank line — so the common case is one-to-one, and allowing many-to-many
-- would buy a rare case at the price of a screen nobody can read. Where it
-- genuinely does not fit, the honest move is to split the receipt, not to
-- blur the match.
create table if not exists bank_reconciliation_match (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references company(id) on delete cascade,
  statement_line_id  uuid not null references bank_statement_line(id) on delete cascade,
  journal_line_id    uuid not null references journal_line(id),
  -- Set when a human confirmed it rather than a rule proposing it, so a
  -- suggested match and an accepted one are never the same record.
  matched_at         timestamptz not null default now(),
  note               text,
  unique (statement_line_id),
  unique (journal_line_id)
);

-- ---------------------------------------------------------------- views ---

-- Every ledger line that ever touched a bank account, and whether a
-- statement line has been put against it. This is the right-hand side of the
-- comparison, and the left join is what makes "in our books, not on the
-- statement" answerable.
create or replace view v_bank_ledger_line as
select jl.id              as journal_line_id,
       jl.company_id,
       jl.account_id,
       a.code             as account_code,
       a.name             as account_name,
       je.entry_date,
       je.entry_no,
       je.id              as journal_entry_id,
       d.id               as document_id,
       d.doc_no,
       d.doc_type,
       p.name             as partner_name,
       jl.memo,
       -- Same sign convention as the statement: a debit to a bank account is
       -- money arriving, so it is positive on both sides and the two columns
       -- can be compared without anybody remembering which way round it goes.
       jl.base_amount     as amount,
       m.id               as match_id,
       m.statement_line_id
  from journal_line jl
  join account a on a.id = jl.account_id
  join journal_entry je on je.id = jl.journal_entry_id
  left join document d on d.journal_entry_id = je.id
  left join business_partner p on p.id = jl.partner_id
  left join bank_reconciliation_match m on m.journal_line_id = jl.id
 where a.is_bank_account;

-- A statement with both sides counted, which is the only number anybody
-- actually wants: how much is still unexplained.
create or replace view v_bank_statement as
select s.id, s.company_id, s.account_id, s.statement_no,
       s.from_date, s.to_date, s.opening_balance, s.closing_balance,
       s.filename, s.status, s.created_at,
       a.code as account_code, a.name as account_name,
       count(l.id)                                          as lines,
       count(l.id) filter (where l.status = 'MATCHED')       as matched,
       count(l.id) filter (where l.status = 'IGNORED')       as ignored,
       count(l.id) filter (where l.status = 'UNMATCHED')     as unmatched,
       coalesce(sum(l.amount), 0)                            as net_movement,
       coalesce(sum(l.amount) filter (where l.status = 'UNMATCHED'), 0)
                                                             as unmatched_value
  from bank_statement s
  join account a on a.id = s.account_id
  left join bank_statement_line l on l.statement_id = s.id
 group by s.id, a.code, a.name;

-- Numbering, alongside every other reference in the system.
create or replace function fn_document_prefix(p_type text, p_direction text)
returns text language sql immutable as $$
    select case
        when p_type = 'CASH_VOUCHER' and p_direction = 'OUT' then 'P'
        when p_type = 'CASH_VOUCHER'                         then 'R'
        when p_type = 'BANK_VOUCHER' and p_direction = 'OUT' then 'BP'
        when p_type = 'BANK_VOUCHER'                         then 'BR'

        when p_type = 'CUSTOMER_RECEIPT'    then 'CR'
        when p_type = 'SUPPLIER_PAYMENT'    then 'CP'
        when p_type = 'JOURNAL_VOUCHER'     then 'J'
        when p_type = 'SALES_INVOICE'       then 'DS'
        when p_type = 'SALES_RETURN'        then 'SR'
        when p_type = 'PURCHASE_INVOICE'    then 'DP'
        when p_type = 'PURCHASE_RETURN'     then 'PR'
        when p_type = 'STOCK_TRANSFER'      then 'ST'
        when p_type = 'GOODS_RECEIPT'       then 'STR'
        when p_type = 'DELIVERY'            then 'SI'
        when p_type = 'STOCK_ADJUSTMENT'    then 'SAJ'
        when p_type = 'CREDIT_NOTE'         then 'CN'
        when p_type = 'DEBIT_NOTE'          then 'DN'

        when p_type = 'PURCHASE_ORDER'      then 'PO'
        when p_type = 'SALES_ORDER'         then 'SO'
        when p_type = 'CASH_TRANSFER'       then 'CT'
        when p_type = 'OPENING_BALANCE'     then 'OB'
        when p_type = 'CONSIGNMENT_RECEIPT' then 'CNR'
        when p_type = 'DELIVERY_TRIP'       then 'TRP'

        -- Not a document and never posted; numbered from the same series so
        -- a statement reads like everything else on file.
        when p_type = 'BANK_STATEMENT'      then 'BST'
        else 'GEN'
    end;
$$;
