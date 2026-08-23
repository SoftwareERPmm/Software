# Myanmar ERP

An ERP system built for the Myanmar market — inventory, distribution, and
accounting for trading and distribution companies.

**Status:** in pilot. The application is built and running — purchases, sales,
inventory, and the ledger all post end to end. An outside tester is using it
against its own database while the books for real use stay empty.

There is deliberately **no authentication yet**: anyone with the deployment URL
has full access. See [open decisions](docs/03-decisions.md) before putting real
customer data behind it.

## Why

Existing options split badly. Foreign ERPs (SAP B1, Odoo, Dynamics) don't
handle Myanmar's realities — Commercial Tax rather than VAT, MMK volatility,
consignment trading, Burmese text. Local incumbents handle those but are built
on architectures that can't carry a proper ledger: balance-forward receivables,
rigid charts of accounts, editable history, and inventory only loosely coupled
to the general ledger.

The bet is that the accounting core is universal and well-understood — so
copy it exactly, correctly, and spend the effort on the Myanmar layer.

## Design principles

1. **The general ledger is the truth.** Every business document generates
   journal entries. Reports read the ledger, never the documents.
2. **Nothing is edited or deleted.** Corrections are reversal documents.
   History is immutable, so the audit trail is free.
3. **Documents don't know their accounts.** A posting-rules table resolves GL
   accounts from item group, partner, warehouse, and tax code. Onboarding a
   client is configuration, never code.
4. **Client-specific behaviour lives in data, never in a branch.** If a
   requirement can only be met by editing code, it becomes a product feature
   for everyone or it doesn't ship.
5. **Unicode-native.** Burmese text is stored, searched, sorted, and printed
   correctly. Legacy encodings are migrated in, never propagated.

## Documents

| | |
|---|---|
| [Scope](docs/00-scope.md) | What v1 is and isn't |
| [Document flow](docs/01-document-flow.md) | Document types, states, and what flows to what |
| [Posting matrix](docs/02-posting-matrix.md) | Every document's GL effect and where accounts resolve from |
| [Open decisions](docs/03-decisions.md) | Unresolved choices, with recommendations |
| [Development setup](docs/04-development.md) | Getting a working copy running, and the rules that keep the ledger correct |

Competitive research is kept locally in `reference/`, outside version control.

## Build order

Flow before schema. The data model is a consequence of the posting design, so
the posting matrix gets settled and reviewed by an accountant before any table
is created.

1. Scope freeze ✅
2. Document flow map ✅
3. Posting matrix ✅ — pending accountant review
4. Data model ✅
5. Walking skeleton ✅ — receive stock, sell it, take payment, produce a trial
   balance that balances and a stock ledger that agrees with the GL

Milestone 5 was the gate. If that chain is correct, everything after it is
addition. If it's wrong, nothing after it can be right. `scripts/test-empty.mjs`
re-proves the whole chain against an empty database on demand, which is what
makes it safe to hand a freshly cleared database to someone.

Still open before this is more than a pilot: authentication and permissions,
and an audit trail over the posting rules — both in
[open decisions](docs/03-decisions.md).
