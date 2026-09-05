import { getFinanceData, createAccountOpening } from "@/lib/actions";
import { OpeningForm } from "@/components/opening-form";

export default async function AccountOpening() {
  const { accounts, accountTree } = await getFinanceData();
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Cash &amp; Bank</span>
        <h1>Account opening</h1>
        <span className="page-sub">
          What each account stood at when you started. Whatever the balances do
          not account for goes to Opening Balance Equity, so the entry balances
          without anyone working the figure out by hand.
        </span>
      </div>

      <OpeningForm
        action={createAccountOpening}
        accounts={accounts as never}
        accountTree={accountTree as never}
        today={today}
      />
    </>
  );
}
