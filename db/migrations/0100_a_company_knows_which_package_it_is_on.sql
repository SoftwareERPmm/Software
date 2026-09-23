-- A company knows which package it is on.
--
-- The product is sold in three packages — Starter, Business, Enterprise —
-- and until now that existed only on a price list. Every customer got the
-- same build: the same 92 screens, the same nav, the same everything. A
-- corner shop on Starter and a distributor on Enterprise were
-- indistinguishable from inside the software, which makes the price
-- difference hard to defend and the smaller customer's first impression
-- worse than it needs to be.
--
-- This adds only the column. Nothing reads it, nothing is limited, no screen
-- changes. That is deliberate: one tier's numbers are agreed (Starter is one
-- branch and three warehouses) and the other two are not, and a limit
-- enforced against half a decision is worse than none — it would have to be
-- loosened later, and loosening a limit somebody has already hit is a
-- support conversation rather than a migration.
--
-- Every existing company is set to STARTER because that is the honest
-- default for a column nobody has chosen a value for yet. It has no effect
-- today. Worth knowing before it does: both databases already hold two
-- branches, so whenever the branch limit is switched on, existing data will
-- be over it and will have to be grandfathered rather than refused — nothing
-- posted should ever be invalidated by a change to a price list.

alter table company
  add column if not exists plan text not null default 'STARTER';

alter table company drop constraint if exists company_plan_check;
alter table company add constraint company_plan_check
  check (plan in ('STARTER', 'BUSINESS', 'ENTERPRISE'));

comment on column company.plan is
  'Which package this company is sold on: STARTER, BUSINESS or ENTERPRISE. '
  'Nothing enforces limits from it yet — see lib/plans.ts for the numbers '
  'agreed so far and the ones still to be decided.';
