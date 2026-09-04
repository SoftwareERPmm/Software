# Working with Claude on this repo

Notes for any Claude Code session opened here — committed so they travel with
the repo across machines, not just the one they were written on.

## Read first

- [docs/04-development.md](docs/04-development.md) — setup, scripts, and the
  hard rules for touching the ledger (never write outside `lib/posting.ts`,
  never store a derived figure, corrections are reversals, never edit an
  applied migration)
- [docs/02-posting-matrix.md](docs/02-posting-matrix.md) — what every document
  type does to the ledger
- [docs/01-document-flow.md](docs/01-document-flow.md) — how documents chain
  together (Order → Delivery/Receipt → Invoice → Payment)
- [docs/03-decisions.md](docs/03-decisions.md) — resolved and open design
  decisions, with the reasoning behind each
- [docs/05-ui-rebuild.md](docs/05-ui-rebuild.md) — the UI rebuild in progress
  on `feature/ui-documents-list`: the reference material, how the theme is
  layered, why `--brand` is separate from `--dr`, what is done and what is
  not. **Read this before touching any UI.**

## Git

- Never commit or push without an explicit instruction in that message
  ("commit", "push", "push commit"). An earlier approval doesn't carry
  forward to later changes.
- `main` deploys straight to the live site with no review step. **All work
  goes on `dev` first** — standing rule set 2026-09-02: code and edit against
  the `dev` Neon database, commit on the `dev` git branch, push it, then merge
  `dev` into `main` to go live. See "Git branches and what deploys where"
  below. Never commit straight onto `main`.
- Never stage `Software/` — a stray untracked duplicate clone of this same
  repo, stuck on an old commit. Always `git add` explicit paths, never
  `-A`/`.`.

## Deployment

- GitHub: `SoftwareERPmm/Software`. `main` is the production branch — Vercel
  deploys it on every push. `dev` and `feature/*` build previews instead.
- Hosting: Vercel project "software" (`prj_4VHZiHWbYM79np3m5ogjsjDY5dKF`),
  team "Kaung Htet's projects" (`team_vPlcInd1S2X9k0g9oQveX4lc`).
- Database: Neon Postgres, three branches off `main`. Which one is "live" is
  decided solely by Vercel's `DATABASE_URL` env var, not by the branch name:
  - **`pilot`** — what Vercel currently serves; the outside tester's data.
    Company name is set to "MTK Co Ltd" here.
  - **`main`** — empty and reserved for real books. Company name is still the
    placeholder "My Company", which doubles as the marker for telling the two
    apart from outside (both are otherwise empty and look identical).
  - **`dev`** — local `.env` points here, so `npm run dev` and test scripts
    use it by default. Cleared too, and its company name carries a "— DEV"
    suffix so it is obvious at a glance which environment is on screen. The
    pre-2026-08-18 dataset it used to hold was exported first to
    `~/erp-dev-backup-2026-08-18.json` (outside the repo, deliberately).
  - Never let a local command write to `pilot` or `main`. Anything
    destructive or schema-changing against them is a deliberate, one-off act:
    pass that URL explicitly on the command line, never from `.env`.
  - The app is single-company ("first company wins" in ~16 queries, no
    switcher), so one database serves exactly one business. Running a real
    customer and a tester simultaneously needs a second Vercel project on the
    same repo with its own `DATABASE_URL` — not a second company row.
  - Vercel env var changes only take effect after a redeploy. To check which
    branch is live without the dashboard, read the sidebar company name.
- Wiping data: `node scripts/clear.mjs` (dry run) → add `--confirm` to act,
  `--all` to take demo master data too. It keeps everything needed to post
  (company, chart of accounts, system accounts, posting rules, fiscal
  calendar, locations, units, tax codes, FOC reasons) and restarts document
  numbering at 1. `scripts/test-empty.mjs` then proves a cleared database
  still posts end to end — but it writes data, so re-clear after running it.
  Do not use `migrate.mjs --reset --seed` for a fresh start: `db/seed.sql`
  contains demo *transactions*, not just foundation.
- **`scripts/test-setup.mjs` is destructive beyond the other suites**: it
  truncates `company` and `account` as well, then scaffolds "Bootstrap Test
  Co". The chart it rebuilds is now the same MTK one, so that part comes back
  identical — but the company name and code are the fixture's, and since the
  app is single-company the sidebar then reads "Bootstrap Test Co". Put it
  back with `update company set name = 'MTK Co Ltd — DEV', code = 'MTK'`.
- **One chart, three places that build it.** `db/chart.mjs` holds it;
  `lib/setup.ts` scaffolds from it, `scripts/load-coa.mjs` re-charts an
  existing company from it, and `db/seed.sql` carries a generated copy —
  regenerate that with `node scripts/gen-seed-chart.mjs`, and
  `--check` fails if it has drifted. Three different charts is what left a
  freshly set-up company unable to charge a delivery fee.
- If Vercel MCP tools are connected, use `get_runtime_errors`/
  `get_runtime_logs` against the project/team above to diagnose a reported
  production error directly, rather than asking for server logs to be
  pasted in.

## Git branches and what deploys where

`main` is the production branch: **anything pushed to it is live immediately**,
with no review step. Work on a branch and merge when it is ready.

`dev` is the integration branch (2026-09-02). It replaced `staging`, which is
stale and no longer part of the path.

| Push to | Vercel builds | Reads `DATABASE_URL` for | Who sees it |
| --- | --- | --- | --- |
| `dev` | Preview (stable branch URL) | Preview → `dev` | you only (SSO) |
| `feature/*` | Preview (own URL) | Preview → `dev` | you only (SSO) |
| `main` | **Production** | Production → `pilot` | everyone |

```
git checkout dev                                # work here; local npm run dev
git push origin dev                             # preview URL, safe to break
git checkout main && git merge dev && git push  # goes live
git checkout dev                                # go straight back
```

The one thing that must not slip: a change needing a migration applies it to
`pilot` **before** `dev` merges into `main`, not after. Pushing `dev` itself is
safe at any time — its preview reads the `dev` database, which is also where
the migration was tested.

A `feature/*` branch is still fine for work risky enough to want isolated, but
it reaches `main` by merging into `dev` first, never directly.

Preview deployments **must** have `DATABASE_URL` scoped to Preview pointing at
`dev`. If the Production row is ticked for all environments instead, every
preview writes to `pilot` — corrupting the tester's data while you experiment.
This is the one case where two rows named `DATABASE_URL` is correct: different
environments, never the same environment twice.

### Current mode: one project, swap the database

There is one Vercel project, and `pilot` and `main` are two *databases* behind
it — not two deployments. So only one is live at a time. Switching audience
means editing the Production `DATABASE_URL`, redeploying, and confirming the
sidebar company name ("MTK Co Ltd" = pilot, "My Company" = main; both are
otherwise empty and identical). Never switch while the tester is mid-session —
their data is safe in `pilot`, but the site would appear to have emptied.

`dev` therefore buys a deployed environment running `dev` data — a place to
see a change working before it is live, which is the whole point of pushing it
before merging.

### Planned: two projects, when both must be live at once

Decided but deliberately deferred (2026-08-18) — the pilot is short and
throwaway, so swapping is enough for now. Build this when real books on `main`
and ongoing testing have to coexist:

| Project | Production branch | Production `DATABASE_URL` | Preview | Audience |
| --- | --- | --- | --- | --- |
| `software-tester` (new) | `dev` | `pilot` | `dev` | tester |
| `software` (existing) | `main` | `main` | `dev` | real customer |

Both track the same repo, so one `git push` keeps them in step, and the
promotion path becomes `dev` (tester validates) → `main` (customers). Set the
production branch under Settings → Git on each project.

Order matters when setting it up, or the tester loses access mid-way:
1. Create `software-tester`, set both env vars, set its branch to `dev`,
   deploy, and verify it shows "MTK Co Ltd".
2. Send the tester that new URL.
3. Only then repoint `software`'s Production row at `main` and redeploy.

New Vercel projects have Authentication disabled by default, so the tester
reaches it without an account. Every feature branch will build a preview on
both projects — harmless duplication; turn previews off on one if it annoys.

## Shipping a change to the live site

Code and data move on completely separate tracks. The Neon branches hold
data; there is one codebase, and `git push` deploys it to whichever database
Vercel currently points at. "Getting a new feature onto pilot" is a deploy,
never a data operation — nothing is ever copied between branches.

- **No schema change** (most work): `git push`. Vercel rebuilds and the live
  site has it. Nothing else to do.
- **Needs a migration**: nothing runs migrations automatically — the build
  command is plain `next build`, and there is no `vercel.json`. Apply them by
  hand, in this order:
  1. `npm run db:migrate` — hits `dev` via `.env`; test locally.
  2. `DATABASE_URL="<pilot url>" npm run db:migrate` — **before** pushing.
  3. `git push`.
  4. `main` only needs it when that branch is about to go live.

  Migrating before deploying matters: push code expecting a column that
  doesn't exist yet and the live site errors for whoever is using it.
  Migrating first is safe because these migrations are additive — older code
  ignores a new column. Re-running is harmless; `schema_migration` tracks
  applied files per database with checksums.
- **Symptom of a missed step 2**: the site starts erroring right after a push.
  Run the migration against that database and it recovers without a redeploy.

## The UI rebuild (in progress)

Live on no branch that deploys. Full detail in
[docs/05-ui-rebuild.md](docs/05-ui-rebuild.md); the parts that will bite:

- **`--brand` is the interface accent. `--dr` is the debit colour.** They were
  the same token, so recolouring the product recoloured every debit in the
  ledger. Use `--brand` for chrome, never `--dr`.
- **A fourth Neon branch, `UI-test`**, exists for this work — company name
  "MTK Co Ltd — UI". `.env` points at it, with `dev` commented below.
- The rebuild changes **no** posting, actions, migrations or scripts, and is
  never merged to `main` — `main` is the tester's live site.

## Working style

- Long pasted "advice" or critique documents about this app's design come up
  often — they read like another AI's analysis of the codebase. Verify every
  specific claim against the actual code before implementing any of it.
  Several have contained real misconceptions (e.g. that AR/AP control
  accounts should be manually postable, which the schema deliberately
  blocks via `fn_journal_line_account_guard`).
- For a broad or ambiguous request, or one that touches a hard-to-reverse
  design fork, survey the code for the real options first, then offer a
  small set of concrete, grounded choices rather than guessing.
