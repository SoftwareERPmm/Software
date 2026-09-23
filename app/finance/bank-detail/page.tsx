import { getFinanceData, getAccountLedger, getAccountsLedger } from "@/lib/actions";
import { AccountBook } from "@/components/account-book";

export default async function BankDetail({
  searchParams,
}: {
  searchParams: Promise<{ account?: string; from?: string; to?: string }>;
}) {
  const { account, from, to } = await searchParams;
  const data = await getFinanceData();
  const list = data.bankAccounts as never as { id: string; code: string; name: string }[];

  if (list.length === 0) {
    return <div className="alert">No bank account is set up.</div>;
  }

  const selected = account === "all" ? null : (list.find((a) => a.id === account) ?? list[0]);
  const rows = selected
    ? await getAccountLedger(selected.id, from, to)
    : await getAccountsLedger(list.map((a) => a.id), from, to);

  return (
    <AccountBook
      kind="bank"
      accounts={list}
      selected={selected}
      rows={rows as never}
      basePath="/finance/bank-detail"
      newLinks={[
        { href: "/finance/bank-receipt", label: "+ Bank receipt", primary: true },
        { href: "/finance/bank-payment", label: "+ Bank payment" },
      ]}
    />
  );
}
