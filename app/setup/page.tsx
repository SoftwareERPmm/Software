import { redirect } from "next/navigation";
import { setupCompany, companyExists } from "@/lib/actions";
import { SetupForm } from "@/components/setup-form";
import { HelpHint } from "@/components/help-hint";

export default async function Setup() {
  if (await companyExists()) redirect("/");

  const year = new Date().getFullYear();

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">First run</span>
        <h1>Set up your company</h1>
        <HelpHint>
          This creates the chart of accounts, the financial calendar, a warehouse,
          units and the posting rules &mdash; everything the ledger needs before
          anything can be recorded. No customers, products or transactions are
          created; those are yours to enter.
        </HelpHint>
      </div>

      <SetupForm action={setupCompany} defaultYear={year} />
    </>
  );
}
