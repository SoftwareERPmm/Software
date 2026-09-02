import { getFinanceData, createCashTransfer } from "@/lib/actions";
import { TransferForm } from "@/components/transfer-form";

export default async function InterbranchTransfer() {
  const { cashAccounts, bankAccounts, branches } = await getFinanceData();
  type Acct = { id: string; code: string; name: string };
  const money = [
    ...(cashAccounts as unknown as Acct[]),
    ...(bankAccounts as unknown as Acct[]),
  ];
  const today = new Date().toISOString().slice(0, 10);

  if (money.length < 2) {
    return (
      <>
        <div className="page-head">
          <span className="eyebrow">Cash &amp; Bank</span>
          <h1>Interbranch transfer</h1>
        </div>
        <div className="alert">
          At least two cash or bank accounts are needed to move money between them.
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Cash &amp; Bank</span>
        <h1>Interbranch transfer</h1>
        <span className="page-sub">
          Money between two of your own accounts &mdash; one branch&rsquo;s till to
          another, or the till to the bank. Its own document type, so branch cash
          movements are never mistaken for income or expense.
        </span>
      </div>

      <TransferForm
        action={createCashTransfer}
        accounts={money}
        branches={branches as never}
        today={today}
      />
    </>
  );
}
