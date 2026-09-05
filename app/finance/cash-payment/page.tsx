import Link from "next/link";
import { getFinanceData, peekVoucherNo, createCashVoucher } from "@/lib/actions";
import { VoucherForm } from "@/components/voucher-form";

export default async function CashPayment() {
  const { accounts, accountTree, cashAccounts, branches } = await getFinanceData();
  const today = new Date().toISOString().slice(0, 10);
  const nextNo = await peekVoucherNo("CASH_VOUCHER", "OUT");

  if (cashAccounts.length === 0) {
    return (
      <>
        <div className="page-head">
          <span className="eyebrow">Cash &amp; Bank</span>
          <h1>Cash payment</h1>
        </div>
        <div className="alert">No cash account is set up. Mark one in the chart of accounts as a till.</div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Cash &amp; Bank</span>
        <h1>Cash payment</h1>
        <span className="page-sub">
          Money paid out of the till that isn&rsquo;t against a supplier bill — use{" "}
          <Link href="/payables/pay" style={{ color: "var(--brand)" }}>Pay supplier</Link> for that.{" "}
          <Link href="/finance/cash-detail" style={{ color: "var(--brand)" }}>View the cash book</Link>
        </span>
      </div>

      <VoucherForm
        kind="cash"
        action={createCashVoucher}
        accounts={accounts as never}
        accountTree={accountTree as never}
        branches={branches as never}
        moneyAccounts={cashAccounts as never}
        today={today}
        nextNo={nextNo}
        presetDirection="out"
      />
    </>
  );
}
