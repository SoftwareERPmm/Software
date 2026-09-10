# Open decisions

Choices that are cheap now and expensive once there is live client data.
Each carries a recommendation; none are final.

---

## D1 — Purchase price variance treatment

**Question.** When the supplier's invoice price differs from the receipt
price, where does the difference go?

**Options.**

- *Variance account* — post the whole difference to Purchase Price Variance.
  Simple, one rule, adequate for most trading companies.
- *Inventory revaluation* — revalue stock still on hand, expense only the
  portion already sold. More accurate, materially more work, and it means
  posting into prior periods when receipts and invoices straddle a month-end.

**Recommendation.** Variance account for v1.

**Partly resolved, 2026-09-08 — the invoice-first case has no variance.**
The question above is about a receipt that *estimated* a cost and a bill that
later disagreed. When the bill arrived first there is no estimate: the goods
are valued at the invoice price, GR/IR clears by exactly what arrived, and
nothing reaches Purchase Price Variance. The receipt form fills the cost from
the matched invoice and will not let it be typed over; `_postGoodsReceipt`
re-prices the lines from the invoice regardless of what a caller passes.

What this fixed: receiving 200 units at a typed 120 against a bill of 80 used
to credit 8,000 to variance — a profit recognised on buying stock — and carry
the goods 8,000 above what was owed for them. The same mechanism the other way
expensed the difference and carried stock below what was owed. Receiving more
than was billed is no longer a variance either: the excess stays in GR/IR as
goods held and not yet invoiced, which is what it is.

The invoice price is the *starting* point, not the whole cost — IAS 2 puts
freight, duties and other costs of bringing stock to its location and
condition into inventory too. Those have documents behind them and belong in
landed-cost allocation, which is **not built**; overtyping a receipt was never
a substitute for it.

Still open, and still needing an auditor: the receipt-first case above, where
the bill genuinely disagrees with an estimate already posted. That is where
`PURCHASE_PRICE_VARIANCE` still receives entries, and where the choice between
variance account and inventory revaluation is unresolved.

**Where a correction lands, 2026-09-10.** Editing a supplier invoice takes the
same path, which makes the open question concrete rather than hypothetical.
Twenty boxes received at 100 and billed at 130:

```
STR20260910002 v1  POSTED     1040 Inventory              2,000
                              1060 GR/IR Clearing        -2,000
DP20260910001 v1   REVERSED   1060 GR/IR Clearing         2,000
                              2000 Accounts Payable      -2,000
DP20260910001 v2   POSTED     5050 Purchase Price Var.      600
                              1060 GR/IR Clearing         2,000
                              2000 Accounts Payable      -2,600
```

The 600 is expensed and the twenty boxes stay on the books at 100 each. Under
inventory revaluation the boxes still on hand would be carried at 130 and only
the sold portion would reach the profit and loss. Both are defensible; the
system does the first, and the difference is a real one to put to the auditor
with these numbers in front of them.

**Needs.** Accountant sign-off. This is the single most important question to
put to a Myanmar auditor, because changing it later means re-posting history.

---

## D2 — Inventory valuation method — resolved

**Question.** Weighted average, FIFO, or per-item choice?

**Resolution.** FIFO, tracked per warehouse, applied to every item — not a
per-item choice. Cost layers live in `stock_lot`/`stock_lot_consumption`
(migration `0017_fifo.sql`); a lot's remaining quantity is always derived
(`qty_received - sum(consumption)`), never stored. Consumption draws
oldest-lot-first (`planFifoConsumption` in `lib/posting.ts`), ordered by
`received_date, created_at` so same-day receipts still resolve
deterministically by actual posting order.

Originally shipped as company-wide weighted average per the recommendation
below; converted once expiry/lot-relevant segments made FIFO necessary, per
the "Watch" note that anticipated this. Existing on-hand stock at cutover was
backfilled into one opening lot per item/location, valued at that item's
moving-average cost as of the migration — `fn_moving_average_cost` is left in
the schema only because the backfill needed it, not because it's still used
going forward.

<details>
<summary>Original recommendation (superseded)</summary>

Weighted average, system-wide, for v1. It is what local practice assumes, it
is far simpler under multi-currency, and per-item choice multiplies the test
surface.

**Watch.** FIFO becomes necessary for expiry-tracked goods (pharma, food),
which are real target segments. The valuation layer should be pluggable even
if only one implementation ships.

</details>

---

## D3 — Settlement vs trade discount

**Question.** Confirmed treatment: trade discount nets into the line and posts
nothing; settlement discount posts to its own account.

**Recommendation.** As above — this is standard practice.

**Needs.** Confirmation that it matches how Myanmar distributors actually book
the discounts they give, which are often negotiated per-invoice at payment
time rather than agreed in advance.

---

## D4 — FOC reason codes

**Question.** Free-of-charge goods post to expense rather than COGS, but which
expense? Candidates seen in local practice: promotion, sample, office use,
damaged/written off, staff.

**Recommendation.** A reason-code table on the delivery line, each code mapping
to its own expense account. Configurable per client.

**Needs.** The actual list your clients use. This is worth asking directly —
it is a small feature that will feel like the software understands their
business.

---

## D5 — Exchange rate sourcing

**Question.** Which rate, captured how? CBM reference rate and market rate
diverge, and companies routinely book at a contract rate that matches neither.

**Recommendation.** Store rate *and* rate-source on every transaction, with a
rate-type table (official / market / contract). Do not assume a single daily
rate.

**Needs.** How your clients actually decide the rate they book at. This is
Myanmar-specific and it is a place where getting it right is visibly better
than the alternatives.

---

## D6 — Technology stack

**Question.** Not yet decided. Deliberately deferred until the data model
exists.

**Constraints already known.**

- Unreliable connectivity and power — offline capability matters eventually,
  which rules out designs that assume a live connection
- Sanctions limit payment and cloud provider options
- Clients distrust cloud and cannot run servers well; deployment model is an
  open question in itself
- Data-entry staff are fast on keyboard-driven desktop software. A
  mouse-driven web UI will feel like a downgrade unless keyboard navigation
  is taken seriously from the start

**Needs.** Team size and existing stack familiarity. Also worth a serious look
at extending ERPNext rather than writing a ledger from zero — the honest
comparison hasn't been done yet.

---

## D7 — Burmese text migration

**Question.** Incumbent data appears to be stored in a legacy ASCII-mapped
font encoding (Win Innwa family), not Unicode.

**Recommendation.** Build a legacy-to-Unicode converter as an import tool.
"We convert your existing data" is a sales conversation, not a technical one,
and it is a concrete wedge against every incumbent.

**Needs.** A sample data export from a real client to confirm which encoding
is actually in the database, rather than only in the printed manual.
