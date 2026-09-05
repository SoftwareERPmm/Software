# Development setup

Getting a working copy running, and the rules that keep the ledger correct.

## Prerequisites

| | |
|---|---|
| Node | 20 or newer (24 is what this is built against) |
| PostgreSQL | 16 or newer, running locally |
| Git | any recent version |

You do **not** need access to the production database to develop. Everything
runs against a local Postgres, and the test suite assumes it can wipe that
database freely.

## First run

```bash
git clone <repo-url>
cd Software
npm install
```

Create a local database and a role for it:

```sql
create role erp_dev with login password 'choose-something';
create database myanmar_erp_dev owner erp_dev encoding 'UTF8';
```

Copy `.env.example` to `.env` and point it at that database:

```
DATABASE_URL=postgresql://erp_dev:choose-something@127.0.0.1:5432/myanmar_erp_dev
```

Note the port. A machine with more than one Postgres installed may not have
the version you want on 5432 — check `postgresql.conf` if connections fail.

Then build the schema and load demo data:

```bash
npm run db:migrate -- --reset --seed
npm run dev
```

`--reset` drops and recreates the schema. Safe locally, never against
anything else.

## Scripts

| | |
|---|---|
| `npm run dev` | Next.js in development |
| `npm run build` | Production build. Type errors fail it. |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:migrate -- --reset --seed` | Rebuild from nothing with demo data |
| `node scripts/check.mjs` | Run the accounting invariants against `DATABASE_URL` |
| `node scripts/probe.mjs <url>` | Prove a database is reachable and writable |
| `node scripts/clear.mjs --all --confirm` | Remove demo data, keep the chart of accounts |

## Tests

Each script posts real documents and then verifies the ledger. They reset the
database first, so run them against a scratch copy only.

```bash
npx tsx scripts/test-posting.mjs        # purchase, sale, COGS, promotions
npx tsx scripts/test-settlement.mjs     # part payments, invoice status
npx tsx scripts/test-ap-ledger.mjs      # payables never overwritten
npx tsx scripts/test-finance.mjs        # cash, bank, journal, transfer, opening
npx tsx scripts/test-inline-item.mjs    # creating items mid-voucher
npx tsx scripts/test-category-tree.mjs  # restructuring categories
npx tsx scripts/test-empty.mjs          # a cleared database still works
npx tsx scripts/test-evil.mjs           # the attacks a determined user would try
npx tsx scripts/test-grir.mjs           # goods-receipt / invoice matching, line by line
npx tsx scripts/test-foc.mjs            # free-of-charge goods land in expense
npx tsx scripts/test-returns.mjs        # returns bounded and costed by their source
npx tsx scripts/test-consignment.mjs    # receipt without ownership
npx tsx scripts/test-consignment-sale.mjs   # and settlement when it sells
npx tsx scripts/test-branch-dimension.mjs   # every journal line carries its branch
npx tsx scripts/test-delivery-fee.mjs   # carriage kept out of sales revenue
npx tsx scripts/test-year-rollover.mjs  # document numbers survive a new fiscal year
npx tsx scripts/test-item-import.mjs    # the item master from a spreadsheet
npx tsx scripts/test-voucher-import.mjs # cash and bank receipts from a spreadsheet
npx tsx scripts/test-units.mjs          # retiring a unit disturbs nothing counting in it
npx tsx scripts/test-match-direction.mjs    # a receipt and its invoice see each other both ways
npx tsx scripts/test-purchase-states.mjs    # ordered / received / invoiced / paid, every combination
npx tsx scripts/test-reference-numbers.mjs  # Type + Date + sequence, and nothing repeating
npx tsx scripts/test-void.mjs           # voiding and editing without rewriting anything
```

Some of these assert the **seed** chart's account codes (1200, 1300, 4100,
5100). A database running a customer's own chart — `dev` does, via
`scripts/load-coa.mjs` — fails those checks while the ledger is perfectly
correct. `test-posting`, `test-grir`, `test-foc` and two checks in
`test-empty` are the ones affected. That is the tests tracking the seed, not
a regression; confirm against a seed-chart database before chasing one.

Plus the database's own invariants, which are enforced by triggers rather
than application code:

```bash
psql "$DATABASE_URL" -f db/tests/smoke.sql
```

Every line of that must read PASS.

## Read these before changing anything

| | |
|---|---|
| [Posting matrix](02-posting-matrix.md) | What every document does to the ledger. The most important file here. |
| [Document flow](01-document-flow.md) | How documents chain together |
| [Scope](00-scope.md) | What v1 covers, and what was deliberately left out |
| [Open decisions](03-decisions.md) | Choices not yet settled, with recommendations |
| [db/README.md](../db/README.md) | Schema conventions and what the database enforces itself |

## Rules

**Never edit an applied migration.** The runner stores a checksum and will
refuse to run if a file has changed since it was applied. Write a new
migration instead. `--reset` is the only exception, and only locally.

**Never write to the ledger except through `lib/posting.ts`.** Journal
entries must balance, resolve their accounts from the posting rules, and
happen in the same transaction as the stock movement they belong to. An
`INSERT` that bypasses this will be rejected by the database, which is the
point, but it will also waste your afternoon.

**Never store a derived figure.** Stock on hand, invoice outstanding, and
payment status are all computed from the ledger. There is no `qty_on_hand`
column and no `status` column on an invoice, deliberately — a stored copy is
a second source of truth that drifts.

**Corrections are reversals.** Posted entries and stock movements cannot be
updated or deleted; the database blocks it. Post a reversing document.

**Money is `numeric`, never a float.** Quantities are stored in the item's
base unit.

## Access

Development needs none of the following. Ask only when you actually do.

| | |
|---|---|
| Local database | Yours, wipe it freely |
| Production database | Not routinely granted. Ask for a branch if you need real-shaped data. |
| Vercel | Read access to deployments and logs is usually enough |

Production credentials do not belong in the repo, in a ticket, or in chat.
`.env` is gitignored and must stay that way.
