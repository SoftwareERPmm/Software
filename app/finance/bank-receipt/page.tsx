import Link from "next/link";
import { getFinanceData, createBankVoucher } from "@/lib/actions";
import { VoucherForm } from "@/components/voucher-form";

export default async function BankReceipt() {
  const { accounts, bankAccounts, locations } = await getFinanceData();
  const today = new Date().toISOString().slice(0, 10);

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
      </div>

      <VoucherForm
        kind="bank"
        action={createBankVoucher}
        accounts={accounts as never}
        locations={locations as never}
        moneyAccounts={bankAccounts as never}
        today={today}
        nextNo="BV-"
        presetDirection="in"
      />
    </>
  );
}
