import Link from "next/link";
import { getFinanceData, peekVoucherNo, createBankVoucher } from "@/lib/actions";
import { getCompany } from "@/lib/queries";
import { VoucherForm } from "@/components/voucher-form";
import { VoucherHelp } from "@/components/voucher-help";
import { ErpCrumbs } from "@/components/erp-worklist";

export default async function BankPayment() {
  const { accounts, accountTree, bankAccounts, branches } = await getFinanceData();
  const company = await getCompany();
  const today = new Date().toISOString().slice(0, 10);
  const nextNo = await peekVoucherNo("BANK_VOUCHER", "OUT");

  if (bankAccounts.length === 0) {
    return (
      <>
        <ErpCrumbs steps={[
          { label: "Cash & bank" },
          { label: "Bank payment" },
        ]} />
        <div className="page-head">
          <h1>Bank payment</h1>
        </div>
        <div className="alert">No bank account is set up in the chart of accounts.</div>
      </>
    );
  }

  return (
    <>
      <ErpCrumbs steps={[
        { label: "Cash & bank" },
        { label: "Bank payment" },
      ]} />
      <div className="page-head">
        <h1>Bank payment</h1>
        <span className="page-sub">
          Money paid out of a bank account that isn&rsquo;t against a supplier bill — use{" "}
          <Link href="/payables/pay" style={{ color: "var(--brand)" }}>Pay supplier</Link> for that.{" "}
          <Link href="/finance/bank-detail" style={{ color: "var(--brand)" }}>View the bank book</Link>
        </span>
      <span className="actions">
        <VoucherHelp kind="bank" />
      </span>
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
        companyName={company?.name ?? ""}
        presetDirection="out"
      />
    </>
  );
}
