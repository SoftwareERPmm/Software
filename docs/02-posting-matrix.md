# Posting matrix

Every document's effect on the general ledger, and — the important column —
where each account number resolves from.

Because accounts are looked up from item group, partner, warehouse, and tax
code rather than hardcoded, onboarding a client means filling in a mapping
table. No code, no branch. This table is the entire accounting engine.

**Status:** pending review by a Myanmar accountant. See
[open decisions](03-decisions.md).

## Non-posting documents

Purchase Order, Sales Order, Transfer Request. They move no stock and touch no
ledger — they exist to be fulfilled and reported against. Keeping them strictly
non-posting removes a whole class of bugs.

## Purchase cycle

**Goods Receipt** — 100 units @ 8,000 on the PO:

```
Dr  Inventory                   800,000     ItemGroup.inventory_account
    Cr  GR/IR Clearing                      800,000    system
```

**Purchase Invoice** — supplier bills 810,000, all 100 units still in stock:

```
Dr  GR/IR Clearing              800,000     system
Dr  Inventory                    10,000     ItemGroup.inventory_account
    Cr  Accounts Payable                    810,000    Partner.ap_control
```

The 10,000 is a cost that was wrong, not an expense, so it goes back onto the
goods it was wrong about. Had 40 of the 100 units already been sold, the split
would follow where they are — 6,000 onto the stock still held and 4,000 to cost
of sales — and the stock movement carrying it adds **zero quantity**: nothing is
received twice. Goods issued afterwards are relieved at the corrected 8,100.
See [decision D1](03-decisions.md) for why, and what it replaced.

Purchase Price Variance still exists, for a difference with no goods behind it.

**Supplier Payment** — with 10,000 settlement discount:

```
Dr  Accounts Payable            810,000     Partner.ap_control
    Cr  Bank / Cash                         800,000    selected
    Cr  Purchase Discount Received           10,000    system
```

**Purchase Return** — reverses the receipt if the invoice hasn't landed;
reverses the receipt *and* raises a debit note against AP if it has.

## Sales cycle

**Delivery** — stock leaves, cost recognised, no revenue:

```
Dr  Cost of Goods Sold          600,000     ItemGroup.cogs_account
    Cr  Inventory                           600,000    ItemGroup.inventory_account
```

**Sales Invoice** — revenue recognised, no stock effect:

```
Dr  Accounts Receivable       1,000,000     Partner.ar_control
    Cr  Sales Revenue                     1,000,000    ItemGroup.revenue_account
```

Trade discount is netted into the line and posts nothing. Only settlement
discount gets its own account.

**Customer Receipt**:

```
Dr  Bank / Cash               1,000,000     selected
    Cr  Accounts Receivable               1,000,000    Partner.ar_control
```

**Sales Return** — reverses both halves: contra-revenue against AR, and
inventory back against COGS at the original cost.

**FOC / sample / office use** — distribution here runs on this, and it is the
case most often posted wrong. Stock moves, cost lands in expense rather than
COGS, no revenue and no receivable:

```
Dr  Promotion / Sample Expense     cost     by FOC reason code
    Cr  Inventory                           cost       ItemGroup.inventory_account
```

## Inventory and general

| Document | Posting |
|---|---|
| Stock Adjustment (increase) | Dr Inventory / Cr Stock Adjustment |
| Stock Adjustment (decrease) | Dr Stock Adjustment / Cr Inventory |
| Stock Transfer | No GL entry — unless locations map to different inventory accounts, then Dr Inventory (to) / Cr Inventory (from) |
| Journal Entry | Manual, free-form, must balance |
| Opening Balances | **One** journal entry against Opening Balance Equity, carrying AR, AP, and inventory detail |

That last row is deliberate. The incumbent runs three separate opening
processes — GL, AR/AP, and inventory — which must then be reconciled by hand
and never quite agree. One opening entry with subledger detail attached makes
the reconciliation problem structurally impossible.

## Multi-currency

On settlement, when the rate has moved since the invoice:

```
Dr  Accounts Payable                        at invoice rate
Dr  FX Loss on Settlement                   difference          system
    Cr  Bank                                            at payment rate
```

Unrealised FX on open items at period end is a revaluation run — deferred, but
the per-line rate storage that makes it possible is in the core schema from
day one.

MMK invoices get rounded, so rounding differences need somewhere to land.

## System accounts

Set once per client during onboarding. Everything else routes through item
group, partner, or warehouse.

- GR/IR Clearing
- Purchase Price Variance
- Purchase Discount Received
- Sales Discount Allowed
- Stock Adjustment
- Promotion / Sample Expense
- FX Gain on Settlement
- FX Loss on Settlement
- Rounding Difference
- Opening Balance Equity
- Retained Earnings

## Invariants

The tests that must hold after every posting:

1. Every journal entry balances — debits equal credits, per document, per currency.
2. The GL inventory account equals the sum of the stock ledger, valued.
3. The AR control account equals the sum of open customer items.
4. The AP control account equals the sum of open supplier items.
5. No posting exists in a locked period.

Invariant 2 is the one that separates real ERP from invoicing software, and
it is exactly the check the incumbent's architecture makes hard.
