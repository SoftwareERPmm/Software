import Link from "next/link";
import { getFinanceData, createBankVoucher } from "@/lib/actions";
import { VoucherForm } from "@/components/voucher-form";

export default async function BankPayment() {
  const { accounts, accountTree, bankAccounts, locations } = await getFinanceData();
  const today = new Date().toISOString().slice(0, 10);

  if (bankAccounts.length === 0) {
    return (
      <>
        <div className="page-head">
          <span className="eyebrow">Cash &amp; Bank</span>
          <h1>Bank payment</h1>
        </div>
        <div className="alert">No bank account is set up in the chart of accounts.</div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Cash &amp; Bank</span>
        <h1>Bank payment</h1>
        <span className="page-sub">
          Money paid out of a bank account that isn&rsquo;t against a supplier bill — use{" "}
          <Link href="/payables/pay" style={{ color: "var(--brand)" }}>Pay supplier</Link> for that.{" "}
          <Link href="/finance/bank-detail" style={{ color: "var(--brand)" }}>View the bank book</Link>
        </span>
      </div>

      <VoucherForm
        kind="bank"
        action={createBankVoucher}
        accounts={accounts as never}
        accountTree={accountTree as never}
        locations={locations as never}
        moneyAccounts={bankAccounts as never}
        today={today}
        nextNo="BV-"
        presetDirection="out"
      />
    </>
  );
}
