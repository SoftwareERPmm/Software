# The UI rebuild

Started 2026-08-24, on `feature/ui-documents-list`. **Not merged, not live.**
Production still serves the pre-rebuild UI from `main`.

This file exists so the work survives changing machines. Everything needed to
pick it up is here; nothing important lives only in a chat log.

## Where it came from

The reference material is <https://github.com/MaxxNesta/UIUXtest> — Odoo 19's
interaction patterns reimplemented for Next.js, with 60 screenshots and a
theme layer meant to drop into an existing design system. Clone it next to
this repo to look at the screenshots again:

```bash
git clone --depth 1 https://github.com/MaxxNesta/UIUXtest.git
open UIUXtest/screenshots/            # p2p_2_po_confirmed.png is the archetype
less UIUXtest/docs/findings.md        # the measured conclusions
```

**What is taken:** structure, density, and the interaction patterns.
**What is not:** Odoo's purple `#71639e`, its name, and its logo are
trademarks. Their own README says so. `--erp-brand` points at our green.

The findings worth remembering, because they drove the decisions:

- Odoo has no per-screen UI code — one shell driven by state. Screen-by-screen
  never converges on that, so the shell came first.
- Every document is one of two archetypes: `transaction` (statusbar, line
  grid, workflow) or `master` (smart buttons, tabs). Sales and purchase are
  the *same* transaction document in different vocabulary.
- Density is measured, not guessed: 40px rows, 25px buttons, 14px body text
  on a **16px root**. Keeping the root at 16 is the trick — dense type
  without shrinking the whole spacing scale.
- "Immutability is shown, not enforced by error." On a posted document the
  controls are simply absent. **We do the opposite today** — migration 0023
  refuses the edit with a database error. The guard is right and stays; the
  UI should stop offering the action. *Not yet done.*

## How the theme is layered

Four files, in this order. The separation is the point: an upstream update is
a diff of one file, not archaeology.

| File | What | Touch it? |
|---|---|---|
| `app/erp/theme.css` | vendored semantic roles + density scale | no — re-vendor from upstream |
| `app/erp/bridge.css` | **the seam**: roles → this product's tokens | yes — this is where palette lives |
| `app/erp/components.css` | primitives (`.erp-panel`, `.erp-tr`, `.erp-stage`…) | yes |
| `app/globals.css` | imports the three, holds the product tokens | rarely |

Two things from upstream are deliberately **not** copied: its `:root` block
and its `body` rule would fight `globals.css` over font and background, which
is exactly what the bridge exists to prevent. Its hard-coded dark greys are
overridden in `bridge.css` because they out-specify a bare `:root` and would
otherwise win in dark mode — silently, where contrast matters most.

Density is per-subtree: `<div data-density="odoo">`. `compact` is 32px rows,
`comfortable` 52px. Screens can migrate one at a time.

## Colour

`--brand` is **forest green `#1B5E43`**, chosen by measuring contrast, not by
eye: 7.70:1 as text on white and under white button text. Dark mode uses
`#5FCB98` (8.63:1 on `#161B22`) — a *different* green, not a tint, because
the dark one is unreadable there.

**`--brand` is separate from `--dr` on purpose.** `--dr` and `--cr` are the
debit and credit colours: they carry meaning on a figure, and a journal line
coloured by them is saying which side it is on. They were also serving as the
link and button colour, so recolouring the product would have recoloured every
debit in the ledger. When adding UI, use `--brand`. Never use `--dr` for
chrome again.

## What is done

- **Documents list** (`app/documents/page.tsx` + `components/erp-document-list.tsx`)
  — control panel, 40px rows, status pills, totals of what is on screen, type
  bar.
- **Every document type** (`app/documents/[id]/page.tsx` +
  `components/erp-doc-shell.tsx`) — breadcrumb, action bar, chevron pipeline,
  sheet. Nine types verified rendering.
- **Sales and purchase orders** (`components/erp-order-form.tsx`) — one
  component, config-driven, with Ordered / Delivered-or-Received / Remaining.
- **Toolbar** (`components/erp-doc-toolbar.tsx`) — star (localStorage), print
  (`window.print()` + `@media print`), copy link. All real, none stubbed.
- **Theme** — green applied product-wide via `--brand`; 32 files repointed.

- **The other ~50 screens**, converted through the shared classes rather than
  one at a time. `.page-head` became a control bar, `.card` a sheet, tables
  40px with asymmetric padding, search an underline, buttons 27px. These are
  overrides appended after the originals, so the `.erp-*` pages are untouched
  and both can coexist while individual screens are migrated properly.

## What is not done

- Individual screens still use the *generic* conversion above, not a
  purpose-built ERP layout. The document screens show what a properly
  rebuilt one looks like; the rest inherit the density and chrome. Migrate
  them one at a time by moving them onto `.erp-*` classes.
- The dashboard.
- "Show immutability instead of erroring" — see the findings above.
- Invoiced-per-order-line. Deliberately skipped: on this chain an invoice
  points at the *delivery*, not the order, so it needs a hop that only
  sometimes resolves. A column right most of the time is worse than none.
- Smart buttons (the Odoo count-boxes linking to related records).

## Rules this work is under

1. **No backend changes.** No posting, no actions, no migrations, no scripts.
   The one exception so far is `getOrderProgress` in `lib/queries.ts` — a
   read-only SELECT feeding the Delivered column, zero write statements.
2. **Never merge to `main`.** `main` deploys to the tester instantly. Push the
   feature branch; it builds a preview.
3. Preview reads **UI-test**, never pilot. Verify by the sidebar company name.

## The customer's chart of accounts

`scripts/load-coa.mjs` loads MTK's own 69-account chart, replacing whatever is
there. It is **not** seed data: `db/seed.sql` keeps the original 29-account
chart that the test suites assert against, and the two are deliberately
separate so adopting one does not silently rewrite the other.

```bash
node scripts/load-coa.mjs             # dry run — shows the target and what it would add
node scripts/load-coa.mjs --confirm   # replace the chart
npx tsx scripts/test-empty.mjs        # prove it still posts
```

It refuses outright if the database has posted journal lines, and refuses a
database other than the one in `.env` unless the host is named — same guard
`clear.mjs` uses.

**Six accounts are added that the customer's chart does not contain**, because
the engine resolves seventeen roles and raises if any is missing: GR/IR
Clearing (1060), Purchase Price Variance (5050), Cost of Goods Sold (5040),
Opening Balance Equity (3030), FX Gain (4110) / FX Loss (6170), Rounding
Difference (6180). A chart without them looks complete and cannot post.

Two judgement calls recorded so they can be revisited: `COGS` resolves to
**5040**, not to *5000 Purchase* — inventory here is perpetual FIFO, so
"Purchase" belongs to a periodic system and is left unused. And the tax
accounts are typed `LIABILITY`, since the `account_type` enum has no Tax
member and tax payable is a liability.

**Applied to `dev` only.** `UI-test`, `pilot` and `production` still carry the
seed chart. A consequence worth knowing: `test-posting`, `test-grir` and
`test-foc` assert the seed's codes (1300, 1310, 5100) and so **fail on `dev`**
while passing everywhere else. That is the tests tracking the seed, not the
ledger breaking — `test-empty` passes on both.

## The four databases

Neon branches. The company name is the only way to tell them apart from
inside the app, which is why they differ:

| Neon branch | Company name | Used by |
|---|---|---|
| `UI-test` | MTK Co Ltd — UI | this rebuild; `.env` and Vercel Preview |
| `dev` | MTK Co Ltd — DEV | audit/test work |
| `pilot` | MTK Co Ltd | **the outside tester, live** |
| `production` (called `main` elsewhere) | My Company | reserved for real books |

`.env` holds `UI-test` active with `dev` commented on the line below it —
switch by moving the comment. All four are at migration 0027.

## Picking this up on another machine

```bash
git clone https://github.com/SoftwareERPmm/Software.git && cd Software
git checkout feature/ui-documents-list
npm install
# .env is gitignored — copy it across, or paste the UI-test URL into it
npm run dev            # sidebar must read "MTK Co Ltd — UI"
```

Then read this file, `docs/findings.md` in the reference repo, and the
comments in `app/erp/bridge.css`. The reasoning lives in the code comments
and the commit messages, deliberately — `git log feature/ui-documents-list`
explains why each decision went the way it did.
