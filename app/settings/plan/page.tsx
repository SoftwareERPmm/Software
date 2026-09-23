import { sql } from "@/lib/db";
import { getCompany } from "@/lib/queries";
import { setCompanyPlan } from "@/lib/actions";
import { PLAN_LIMITS, type Plan } from "@/lib/plans";
import { PlanSwitcher } from "@/components/plan-switcher";
import { HelpHint } from "@/components/help-hint";

export default async function PlanSettings() {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const [row] = (await sql`select plan from company where id = ${company.id}`) as
    unknown as { plan: Plan }[];

  // What this company actually holds, so a limit can be read against
  // something real rather than in the abstract.
  const [counts] = (await sql`
    select count(*) filter (where parent_id is null)::int as branches,
           count(*) filter (where is_stock_location)::int as warehouses
      from location where company_id = ${company.id} and is_active`) as
    unknown as { branches: number; warehouses: number }[];

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Settings</span>
        <h1>Package</h1>
        <HelpHint>
          Which package this company is sold on. Switchable so the tiers can
          actually be tested — the point of gating is that Starter looks
          different from Enterprise, and that cannot be checked from a value
          set once at install.
          <br /><br />
          <strong>Nothing is enforced yet.</strong> Only Starter&rsquo;s limits
          are agreed; Business and Enterprise are undecided, and a limit
          enforced against half a decision would have to be loosened later.
          Changing the package today changes no screen and refuses nothing.
        </HelpHint>
      </div>

      <PlanSwitcher
        current={row.plan}
        limits={PLAN_LIMITS}
        have={counts}
        action={setCompanyPlan}
      />
    </>
  );
}
