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

Type, date, sequence — `R20260901001`. Per company, per document type, per
day. Numbers are assigned at posting, never at draft, and are gapless — a
reversed document keeps its number and the reversal gets its own.

The date is what keeps `document.doc_no` and `journal_entry.entry_no` unique
for the life of the company while the count restarts, and it restarts daily:

| | | | |
| --- | --- | --- | --- |
| `R` cash received | `P` cash payment | `CR` customer received | `CP` supplier payment |
| `J` journal | `DS` direct sales | `SR` sales return | `DP` direct purchase |
| `PR` purchase return | `ST` stock transfer | `STR` stock received | `SI` stock issued |
| `SAJ` stock adjustment | `PO` purchase order | `SO` sales order | `CT` cash transfer |
| `BR` bank received | `BP` bank payment | `OB` opening balance | `CNR` consignment receipt |

`SI` is Stock Issued — a delivery. A sales invoice is Direct Sales, `DS`.

Cash and bank vouchers are one document type each carrying money in *or* out,
so `document.voucher_direction` records which and the prefix follows it. It
is set at posting from the sign of the money line (migration 0035).

Two prefixes must never collide: a journal voucher is `J` and a journal entry
is `JE`, because sharing a prefix would mean sharing a counter and issuing the
same number twice.

Documents numbered before migration 0035 keep the previous
`PI-2627-000001` shape — posted documents are immutable and nothing rewrites
them — so a database that was trading before the change carries both. The two
shapes cannot collide, and the earlier fiscal-year segment existed for the
same reason the date does now: without it the second year of trading reissued
the first year's numbers and nothing posted at all (migration 0025).
