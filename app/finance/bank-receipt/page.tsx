import Link from "next/link";
import { getFinanceData, peekVoucherNo, createBankVoucher } from "@/lib/actions";
import { VoucherForm } from "@/components/voucher-form";

export default async function BankReceipt() {
  const { accounts, accountTree, bankAccounts, branches } = await getFinanceData();
  const today = new Date().toISOString().slice(0, 10);
  const nextNo = await peekVoucherNo("BANK_VOUCHER", "IN");

  if (bankAccounts.length === 0) {
    return (
      <>
        <div className="page-head">
          <span className="eyebrow">Cash &amp; Bank</span>
          <h1>Bank receipt</h1>
        </div>
        <div className="alert">No bank account is set up in the chart of accounts.</div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Cash &amp; Bank</span>
        <h1>Bank receipt</h1>
        <span className="page-sub">
          Money received into a bank account that isn&rsquo;t against a customer invoice — use{" "}
          <Link href="/receivables/receive" style={{ color: "var(--brand)" }}>Receive payment</Link> for that.{" "}
          <Link href="/finance/bank-detail" style={{ color: "var(--brand)" }}>View the bank book</Link>
        </span>
        <Link href="/finance/bank-receipt/import" className="btn ghost">Import from Excel</Link>
      </div>

      <VoucherForm
        kind="bank"
        action={createBankVoucher}
        accounts={accounts as never}
        accountTree={accountTree as never}
        branches={branches as never}
        moneyAccounts={bankAccounts as never}
        today={today}
        nextNo={nextNo}
        presetDirection="in"
      />
    </>
  );
}
