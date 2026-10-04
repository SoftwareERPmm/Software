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

**Resolved, 2026-09-11 — the difference goes back onto the goods.**
Inventory revaluation, split by where the goods actually are. See the bottom of
this entry for what that means in entries and why the earlier recommendation
was dropped.

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

**Where a correction landed, 2026-09-10 — and why it moved.** Editing a
supplier invoice took the same path, which made the open question concrete
rather than hypothetical. Twenty boxes received at 100 and billed at 130 posted
this, with the goods left on the books at 100 each:

```
STR20260910002 v1  POSTED     1040 Inventory              2,000
                              1060 GR/IR Clearing        -2,000
DP20260910001 v1   REVERSED   1060 GR/IR Clearing         2,000
                              2000 Accounts Payable      -2,000
DP20260910001 v2   POSTED     5050 Purchase Price Var.      600
                              1060 GR/IR Clearing         2,000
                              2000 Accounts Payable      -2,600
```

That is what a standard-costing system should do, and a variance account is
the whole point of one. It is not what an actual-cost FIFO system should do,
and it produced an obvious absurdity: twenty boxes sitting unsold in the
warehouse, demonstrably worth the 2,600 that was paid for them, carried at
2,000 with the 600 already through the profit and loss.

**What it does now (0057).** The difference is split by where the goods are:

| Situation | Inventory | Cost of sales |
| --- | ---: | ---: |
| All 20 still held | +600 | 0 |
| 8 issued, 12 held | +360 | +240 |
| All 20 issued | 0 | +600 |

Three mechanisms make that work, and each exists because something else in the
schema refused the obvious approach:

- `stock_lot` is append-only, so the lot's cost cannot be edited. A companion
  `stock_lot_adjustment` row carries the correction, and `v_stock_lot_open`
  adds the two together. This is the same shape Odoo reaches by the same
  route — an additional valuation layer rather than a rewritten one.
- The correction has to reach the stock ledger, not just the inventory
  account, because `v_check_inventory_reconciliation` ties one to the other.
  So it writes a `stock_movement` carrying value and **zero quantity**. The
  goods are not received again; the receipt keeps its history and its
  quantity. `stock_movement`'s `qty <> 0` check had to be relaxed to
  `qty <> 0 or total_cost <> 0` to allow it.
- The FIFO draw reads the corrected cost. Without this the 600 would sit in
  the inventory account forever with no stock behind it: goods issued after
  the correction would still be relieved at 100, and the account would never
  come back to zero.

**What did not change.** The issued share lands in cost of sales at the date of
the correction, in whatever period that is — it does not reach back into sales
that already happened, which is where Business Central goes further than this
does and where a closed period would otherwise have to be reopened. And a
revaluation whose goods have since been sold cannot be undone: `planVoid`
refuses it, because taking the value back off would leave the remaining stock
stating one figure and the ledger another. Correct forward with another bill.

**Purchase price variance still exists**, and now means only what its name says:
a difference with no goods behind it. In practice that is a narrow case, since
billing more than was received is refused outright.

Prompted by a comparison against Odoo 18 and Dynamics 365 Business Central,
both of which separate goods still in stock from goods already issued rather
than expensing the whole difference. Proved by `scripts/test-cost-adjustment.mjs`.

**Still worth an accountant's eye**, but no longer a fork in the road: this is
the ordinary actual-cost treatment, and it is what IAS 2 describes. The
question that remains is the narrower one of landed costs — freight, duties and
the rest — which belong in inventory too and are **not built**.

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

---

## D8 — When cost of sales is recognised

**Question.** Today revenue is recognised on the sales invoice and cost on
the delivery. Should cost move to the invoice, so that the two halves of a
sale are recognised on the same document?

**What the engine does now.** `_postDelivery` posts `Dr COGS / Cr Inventory`
at FIFO cost (`lib/posting.ts`, in the per-line loop that writes the stock
movement), and `_postSalesInvoice` posts revenue only — its own comment says
so: *"Revenue only — stock and COGS belong to the delivery, not the
invoice."* Four other paths touch COGS and all follow the delivery's lead:
consignment settlement, sales return, retro cost adjustment, and the
purchase-invoice price variance.

**Why it is worth changing.** In perpetual FIFO the two are recognised on
different documents, so goods delivered in September and billed in October
put the cost in one month and the revenue in the other. Over a year it
washes out; over a month a category can show a 100% margin because its
goods left before its invoice did. Shipping goods also expenses them before
any revenue exists, which is a matching violation however the report is cut.

**The target model.** Deferred COGS, the standard arrangement:

- A new asset account and system role — *Goods shipped not invoiced*. The
  chart has `GRIR_CLEARING` (1060) for the purchase side and no sales
  mirror; this is that mirror.
- Delivery becomes `Dr Deferred COGS / Cr Inventory`. Inventory is relieved
  exactly as it is today — the stock side does not change at all.
- Sales invoice gains `Dr COGS / Cr Deferred COGS` for the FIFO cost of the
  quantity it bills.

**What it does not fix.** An invoice raised before the goods ship still
recognises revenue with no cost against it — there is no deferred balance to
relieve yet. The mismatch is not removed, only reversed in direction.
Closing that needs revenue deferred to shipment as well, which is a larger
change again and is not proposed here.

**The real cost is void and edit, not the journal lines.** Voiding a sales
invoice is revenue-only today, and deliberately so — `lib/void.ts` states
the principle: *"A document this one was raised from is fine to leave alone
— voiding a purchase invoice does not disturb the receipt it billed."* Under
deferred COGS, voiding an invoice must push cost back out of COGS, and to
reverse it the engine has to know exactly which lots and quantities that
invoice claimed.

That is the structural part. `getSalesBreakdown` already matches invoices to
deliveries for the Profitability basis, but it recomputes the allocation on
every page load, which is safe only because nothing is posted from it. Once
COGS is posted on the invoice **the allocation becomes a ledger fact**: it
has to be stored, immutable and reversible, because other invoices may have
claimed the same delivery since and the allocation depends on posting order.
It cannot be recomputed at void time.

Two things are already in our favour. Ordering is mostly enforced — voiding
a delivery an invoice was raised from is refused (*"was raised from this
document. Void that first"*), as is voiding a deliver-later invoice while
its delivery stands; only "void an invoice raised from a delivery" changes
behaviour. And amend is void-and-repost inside one transaction, so releasing
and re-taking an allocation is atomic and cannot be handed different lots
part-way through.

**Also inherited:** partial billing leaves a residual deferred balance that
needs aging, or it accumulates unnoticed — the sales mirror of the problem
`GRIR_AGE_DAYS` and the GR/IR collision report exist to catch.

**Built 2026-10-04.** Cost of sales is now recognised by the sales invoice.
A delivery debits 1090 Goods Shipped Not Invoiced and credits inventory; the
invoice claims the exact FIFO layers the delivery drew, debits cost of sales
and clears 1090. The reporting-basis toggle this change was going to be
measured with has been removed: with both halves of a sale recognised on one
document the two readings converge, and the only residual difference —
revenue invoiced with no goods out behind it — is now a figure on the single
report rather than a second view of it.

Five defects surfaced during the build, four of them found by suites written
long before any of this and one by the scenario matrix:

1. Cost corrections followed the consumption's recorded account into 1090.
   Fixed by keeping two facts apart: the consumption records where cost is
   *destined* (cost of sales, so a correction finds the account the sale used
   even after a re-chart), the journal records where it *sits*.
2. Goods issued before they were received have no lot, so no consumption row,
   so nothing could ever claim their cost. It now goes straight to cost of
   sales rather than being stranded in 1090.
3. The claim drew layers in a non-deterministic order: two receipts on one day
   tie on date and microsecond, leaving a random uuid to decide which cost an
   invoice took. Ordered by the lot now, exactly as the FIFO planner does.
4. An invoice raised from a sales order claimed nothing, because an invoice's
   source_document_id is its delivery and the link to the order lives on each
   line. An order shipped in two loads left its whole cost in 1090.
5. The reconciliation compared releases against all of cost of sales, which
   also receives corrections, returns and negative-stock cost.

**Direction chosen 2026-10-03.** Cost moves to the sales invoice.
Before building it, measure: the reporting-basis toggle on Sales → Sales
report sizes this exactly, because the gap between *Accounting period* and
*Profitability* for a month **is** the error this change removes. On seeded
dev data for October the gap was 12,000 on 561,000 — about 2%. A few real
months on pilot decide whether the work earns its risk.

**Order to build it in**, when that decision is made:

1. Migration: the account, the `SYSTEM` role, and the chart in all three
   places that build it (`db/chart.mjs`, `lib/setup.ts`, `db/seed.sql` via
   `gen-seed-chart.mjs`).
2. The allocation table — invoice line, the consumption it claims, quantity
   and cost — with the constraints that stop it being over-drawn. This is
   the piece everything else depends on, and it is worth writing its tests
   before anything posts against it.
3. `_postDelivery`: route non-FOC cost to Deferred COGS. FOC keeps going to
   the reason's account at delivery, because no invoice ever follows.
4. `_postSalesInvoice`: claim the allocation and post the cost entry.
5. Void and amend: release the allocation, and reverse the cost entry.
6. The paths that follow `stock_lot_consumption.expense_account_id` to send
   a correction back where the cost landed — retro cost adjustment and
   negative-stock reconciliation — now have to ask which side of the invoice
   the cost is on.
7. Sales return: reverse COGS where the goods were invoiced, Deferred COGS
   where they were not.
8. Reports: the Inventory & COGS reconciliation assumes consumption equals
   cost of sales; the sales report's *Accounting period* basis converges on
   *Profitability* once this lands, which is the point, but both need
   re-checking rather than assuming.
9. A deferred-balance aging report. Built already — Finance → Shipped Not
   Invoiced ages the same goods today from the documents, and reads 1090's
   balance so it begins reconciling the two the day this lands.
10. **The invariant that must not break: inventory is relieved exactly
   once.** Verified by trace on 2026-10-03 — today a delivery of 4 units at
   1,000 posts `Dr 5000 Cost of Goods Sold 4,000 / Cr 1040 Inventory 4,000`
   alongside a stock movement of −4, and the sales invoice posts `Dr 1030 /
   Cr 4000` and touches neither 1040 nor 5000.
   Afterwards the delivery must post `Dr 1090 / Cr 1040` — the same credit,
   the same moment, the same amount — and the invoice `Dr 5000 / Cr 1090`,
   touching 1040 not at all. The failure mode is writing the invoice entry
   as `Dr 5000 / Cr 1040` by copying the delivery's: that relieves inventory
   twice, taking 8,000 of stock out for 4,000 of goods. It balances, so
   nothing refuses it, and the trial balance still nets to zero. Only a test
   that sums every credit to 1040 for one sale and compares it against the
   FIFO cost will catch it — write that test before step 4.
11. Around 35 test suites mention COGS or account 5000. Each needs reading
    rather than blanket updating: some are asserting the very thing being
    changed, and some are asserting something else and merely touch it in
    passing. `test-inventory-cogs.mjs` and `test-sales-profitability.mjs`
    are the two that are wholly about this behaviour.

**Acceptance conditions, agreed 2026-10-03.** The switch is not done until
all six hold, and each is a way the change fails quietly rather than loudly:

1. **Cost release uses the stored claim rows, never a recalculated
   average.** The allocation is a ledger fact. Recomputing it at release
   time can give a different answer, because other invoices may have
   claimed the same delivery since and the result depends on claim order.
2. **A partial invoice releases only the cost of the quantity it bills.**
   Billing 4 of a 10-unit delivery moves four units of cost out of 1090 and
   leaves six.
3. **Void and amend write negative allocation rows** and reverse exactly
   the 1090 amount previously claimed — not a fresh calculation of what
   that invoice "should" have taken.
4. **Delivery reversals restore inventory and reverse 1090** where the
   delivery put cost there. A delivery whose cost has already been claimed
   by an invoice cannot be voided while that invoice stands, which the
   existing blocker already enforces.
5. **Free-of-charge lines keep their own expense treatment.** A giveaway's
   cost goes to the reason's account when the goods leave and never passes
   through 1090 or cost of sales, because no invoice is ever coming.
6. **1090 reconciles exactly to `v_delivery_cost_unclaimed`.**

The invariant that tests all six at once:

> **1090 balance = total delivered FIFO cost not yet claimed by invoices**

**One defect this already found, fixed in 0115.** As 0114 defined it, the
view counted every consumed layer in the company, so the invariant could
never have held: receive 100 at 100, give 5 away and deliver 10 against a
sale, and it reported 1,500 — the 1,000 genuinely waiting on an invoice
plus 500 of promotion expense that was settled when the goods left.
`recordFifoConsumption` is called by stock adjustments, transfers and
purchase returns as well as deliveries, so write-offs and internal moves
leaked in the same way. The view is now scoped to posted deliveries,
excluding free-of-charge and consignment lines, and scoped by document and
line rather than by expense account — that account is 5000 today and 1090
afterwards, and a view defined on it would need rewriting halfway through
the transition it exists to verify. `test-cost-allocation.mjs` holds the
figure still across a giveaway, a write-off and a transfer.

**What the invariant means before the switch.** It does not hold yet, and
should not: 1090 is empty because cost still goes straight to 5000, while
the view reports everything delivered, because no allocation rows exist to
claim it. Until the switch the Shipped Not Invoiced report is the honest
figure — it works the unbilled quantity out from the document links rather
than from allocations. Afterwards all three must agree: account balance,
view total, and report total.

**Needs.** A month or two of real pilot trading to size the gap, and an
auditor's view on whether Myanmar practice expects cost at shipment or at
invoice.
