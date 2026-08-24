# Document flow

```
PURCHASE   Purchase Order ──► Goods Receipt ──► Purchase Invoice ──► Payment
                                    │
                                    └──► Purchase Return

SALES      Sales Order ──► Delivery ──► Sales Invoice ──► Receipt
                               │
                               └──► Sales Return

INVENTORY  Stock Adjustment · Stock Transfer · Opening Balance

GENERAL    Journal Entry
```

Every document carries a link to what it came from. From any payment you can
walk back to the invoice, the receipt, and the order. That chain is what
answers "why does this customer owe us this?", and it is what auditors
actually ask for.

## Behaviour per document

| Document | Moves stock | Posts to GL | Partial fulfilment |
|---|---|---|---|
| Purchase Order | — | — | Yes |
| Goods Receipt | Yes (in) | Yes | Yes |
| Purchase Invoice | — | Yes | Yes |
| Purchase Return | Yes (out) | Yes | Yes |
| Supplier Payment | — | Yes | Yes |
| Sales Order | — | — | Yes |
| Delivery | Yes (out) | Yes | Yes |
| Sales Invoice | — | Yes | Yes |
| Sales Return | Yes (in) | Yes | Yes |
| Customer Receipt | — | Yes | Yes |
| Stock Adjustment | Yes | Yes | — |
| Stock Transfer | Yes | Conditional¹ | — |
| Journal Entry | — | Yes | — |

¹ No GL entry when both locations map to the same inventory account, which is
the normal case.

## Two separations that matter

**Delivery is not the invoice.** Stock leaves on delivery; revenue books on
invoice. They are frequently different days and sometimes different months.
Merging them makes both the inventory position and the period cutoff wrong.

**Goods receipt is not the purchase invoice.** Goods arrive before the
supplier's bill does. That gap is what the GR/IR clearing account holds.
Without it you either overstate payables or understate inventory at every
month-end — and the GR/IR balance doubles as a working report, since anything
sitting in it too long is a missing supplier invoice.

Both separations are commonly collapsed in local systems. Neither should be.

## States

Orders: `draft → confirmed → partially fulfilled → fulfilled → closed`
(`cancelled` available before fulfilment begins)

Posting documents: `draft → posted → reversed`

A draft posts nothing and can be freely edited. Once posted, the document is
immutable — a correction is a reversal document plus a new one. `reversed`
records that a reversal exists, it does not erase anything.

## Numbering

Per company, per document type, per fiscal year. Numbers are assigned at
posting, never at draft, and are gapless — a reversed document keeps its
number and the reversal gets its own.

The fiscal year is part of the number, because the count restarts with it
while `document.doc_no` and `journal_entry.entry_no` must stay unique for the
life of the company:

```
FY 2026-27    PI-2627-000001    JE-2627-000001
FY 2027-28    PI-2728-000001    JE-2728-000001
```

A fiscal year that sits inside one calendar year carries the single year
instead — `PI-26-000001`. Without the year segment the second year of trading
reissues the first year's numbers and nothing posts at all; see migration
0025.
