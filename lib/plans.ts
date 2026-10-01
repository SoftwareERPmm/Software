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

/**
 * Features a package includes, as opposed to limits it imposes.
 *
 * Separate from PLAN_LIMITS because the two answer different questions —
 * "how many warehouses may they have" and "is this screen theirs" — and a
 * single table conflating them would make both harder to read.
 *
 * **This gates what is offered, not what is true.** A feature withheld here
 * is a screen the customer does not see; nothing in the ledger changes, and
 * no figure is hidden from a report they can already reach. That line comes
 * from the rule above: hiding a module nobody bought is reasonable, hiding
 * accounts is not.
 */
export type Feature = "supplier_performance";

const FEATURES: Record<Feature, Plan[]> = {
  // Business and Enterprise. A Starter shop buys from a handful of people
  // it already knows; scoring them is a growing company's problem.
  supplier_performance: ["BUSINESS", "ENTERPRISE"],
};

export function planIncludes(plan: Plan, feature: Feature): boolean {
  return FEATURES[feature].includes(plan);
}

/**
 * **Not security.** There is no authentication in this application — no
 * users, no sessions, no identity to check a permission against. Anyone who
 * can reach the server can reach any route on it, and calling this in a
 * page prevents an upsell being given away, not an intruder getting in.
 *
 * It is written as a function rather than inlined so that the day sign-in
 * arrives there is one place to put the real check, and so that a search
 * for the feature finds every screen that offers it.
 */
export function requireFeature(plan: Plan, feature: Feature): boolean {
  return planIncludes(plan, feature);
}
