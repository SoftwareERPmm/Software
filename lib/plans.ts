/**
 * What each package allows.
 *
 * One place, so that when a limit is finally enforced there is a single
 * number to change rather than a condition written into whichever screen
 * happened to need it first.
 *
 * **Nothing reads this yet.** `company.plan` exists (migration 0100) and no
 * code consults it. Only Starter's limits are agreed; the rest are null,
 * which means "not decided" and not "unlimited" — writing Infinity here
 * would look like a decision nobody made.
 *
 * When enforcement does arrive, two rules matter more than the numbers:
 *
 * 1. **Existing data is grandfathered.** Both live databases already hold
 *    two branches. A company over its limit keeps what it has and is
 *    refused only when it tries to add more. Nothing already posted or
 *    configured should ever be invalidated by a change to a price list.
 *
 * 2. **Gate the navigation, not the ledger.** Hiding a module a customer
 *    has not bought is reasonable. Hiding accounts, or refusing to post to
 *    them, is not: the books are theirs whatever they paid, and a trial
 *    balance that omits rows because of a subscription is a wrong trial
 *    balance.
 */

export type Plan = "STARTER" | "BUSINESS" | "ENTERPRISE";

export type PlanLimits = {
  /** Top-level locations — a branch is a location with no parent. */
  branches: number | null;
  /** Locations that hold stock — `is_stock_location`. */
  warehouses: number | null;
  /** People who can sign in. Meaningless until there is a sign-in. */
  users: number | null;
};

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  // Agreed 2026-09-23: a small shop is one place with a few stores in it.
  STARTER: { branches: 1, warehouses: 3, users: null },

  // Not decided. Null is "nobody has said", deliberately distinct from a
  // large number standing in for "plenty".
  BUSINESS: { branches: null, warehouses: null, users: null },
  ENTERPRISE: { branches: null, warehouses: null, users: null },
};

/** Whether a limit is known. An unknown limit never refuses anything. */
export function limitFor(plan: Plan, what: keyof PlanLimits): number | null {
  return PLAN_LIMITS[plan]?.[what] ?? null;
}
