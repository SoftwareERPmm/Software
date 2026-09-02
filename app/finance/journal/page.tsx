import { getFinanceData, createJournalVoucher } from "@/lib/actions";
import { VoucherForm } from "@/components/voucher-form";

export default async function JournalVoucher() {
  const { accounts, accountTree, cashAccounts, bankAccounts, locations } = await getFinanceData();
  const today = new Date().toISOString().slice(0, 10);
  const money = cashAccounts;

  if (accounts.length === 0) {
    return (
      <>
        <div className="page-head">
          <span className="eyebrow">Cash &amp; Bank</span>
          <h1>Journal</h1>
        </div>
        <div className="alert">No postable accounts exist yet.</div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Cash &amp; Bank</span>
        <h1>Journal</h1>
        <span className="page-sub">Free-form entry against any accounts — depreciation, accruals, corrections. Control accounts are not offered; they belong to their subledger.</span>
      </div>

      <VoucherForm
        kind="journal"
        action={createJournalVoucher}
        accounts={accounts as never}
        accountTree={accountTree as never}
        locations={locations as never}
        moneyAccounts={money as never}
        today={today}
        nextNo="JV-"
      />
    </>
  );
}
