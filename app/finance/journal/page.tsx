import { getFinanceData, peekVoucherNo, createJournalVoucher } from "@/lib/actions";
import { getCompany } from "@/lib/queries";
import { VoucherForm } from "@/components/voucher-form";
import { VoucherHelp } from "@/components/voucher-help";
import { ErpCrumbs } from "@/components/erp-worklist";

export default async function JournalVoucher() {
  const { accounts, accountTree, cashAccounts, bankAccounts, branches } = await getFinanceData();
  const company = await getCompany();
  const today = new Date().toISOString().slice(0, 10);
  const nextNo = await peekVoucherNo("JOURNAL_VOUCHER");
  const money = cashAccounts;

  if (accounts.length === 0) {
    return (
      <>
        <ErpCrumbs steps={[
          { label: "General ledger", href: "/finance/general-ledger" },
          { label: "Journal voucher" },
        ]} />
        <div className="page-head">
          <h1>Journal voucher</h1>
        </div>
        <div className="alert">No postable accounts exist yet.</div>
      </>
    );
  }

  return (
    <>
      <ErpCrumbs steps={[
        { label: "Accounting" },
        { label: "Transactions" },
        { label: "Journal voucher" },
      ]} />
      <div className="page-head">
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
        companyName={company?.name ?? ""}
      />
    </>
  );
}
