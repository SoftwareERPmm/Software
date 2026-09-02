import Link from "next/link";
import { getFinanceData, createCashVoucher } from "@/lib/actions";
import { VoucherForm } from "@/components/voucher-form";

export default async function CashReceipt() {
  const { accounts, accountTree, cashAccounts, branches } = await getFinanceData();
  const today = new Date().toISOString().slice(0, 10);

  if (cashAccounts.length === 0) {
    return (
      <>
        <div className="page-head">
          <span className="eyebrow">Cash &amp; Bank</span>
          <h1>Cash receipt</h1>
        </div>
        <div className="alert">No cash account is set up. Mark one in the chart of accounts as a till.</div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Cash &amp; Bank</span>
        <h1>Cash receipt</h1>
        <span className="page-sub">
          Money received into the till that isn&rsquo;t against a customer invoice — use{" "}
          <Link href="/receivables/receive" style={{ color: "var(--brand)" }}>Receive payment</Link> for that.{" "}
          <Link href="/finance/cash-detail" style={{ color: "var(--brand)" }}>View the cash book</Link>
        </span>
        <Link href="/finance/cash-receipt/import" className="btn ghost">Import from Excel</Link>
      </div>

      <VoucherForm
        kind="cash"
        action={createCashVoucher}
        accounts={accounts as never}
        accountTree={accountTree as never}
        branches={branches as never}
        moneyAccounts={cashAccounts as never}
        today={today}
        nextNo="CV-"
        presetDirection="in"
      />
    </>
  );
}
