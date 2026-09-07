import { getFinanceData, peekVoucherNo, createJournalVoucher } from "@/lib/actions";
import { VoucherForm } from "@/components/voucher-form";
import { VoucherHelp } from "@/components/voucher-help";

export default async function JournalVoucher() {
  const { accounts, accountTree, cashAccounts, bankAccounts, branches } = await getFinanceData();
  const today = new Date().toISOString().slice(0, 10);
  const nextNo = await peekVoucherNo("JOURNAL_VOUCHER");
  const money = cashAccounts;

  if (accounts.length === 0) {
    return (
      <>
        <div className="page-head">
          <span className="eyebrow">Accounting</span>
          <h1>Journal voucher</h1>
        </div>
        <div className="alert">No postable accounts exist yet.</div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Accounting</span>
        <h1>Journal voucher</h1>
        <span className="page-sub">
          Record depreciation, accruals and other accounting adjustments.
        </span>
      <span className="actions">
        <VoucherHelp kind="journal" />
      </span>
      </div>

      <VoucherForm
        kind="journal"
        action={createJournalVoucher}
        accounts={accounts as never}
        accountTree={accountTree as never}
        branches={branches as never}
        moneyAccounts={money as never}
        today={today}
        nextNo={nextNo}
      />
    </>
  );
}
