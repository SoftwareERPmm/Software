import { getFinanceData, getAccountLedger, getAccountsLedger } from "@/lib/actions";
import { AccountBook } from "@/components/account-book";

export default async function CashDetail({
  searchParams,
}: {
  searchParams: Promise<{ account?: string; from?: string; to?: string }>;
}) {
  const { account, from, to } = await searchParams;
  const data = await getFinanceData();
  const list = data.cashAccounts as never as { id: string; code: string; name: string }[];

  if (list.length === 0) {
    return <div className="alert">No cash account is set up.</div>;
  }

  // "all" is a real choice rather than the absence of one, so landing here
  // without a parameter still opens the first account and its running
  // balance — the figure somebody checks the till against.
  const selected = account === "all" ? null : (list.find((a) => a.id === account) ?? list[0]);
  const rows = selected
    ? await getAccountLedger(selected.id, from, to)
    : await getAccountsLedger(list.map((a) => a.id), from, to);

  return (
    <AccountBook
      kind="cash"
      accounts={list}
      selected={selected}
      rows={rows as never}
      basePath="/finance/cash-detail"
      newLinks={[
        { href: "/finance/cash-receipt", label: "+ Cash receipt", primary: true },
        { href: "/finance/cash-payment", label: "+ Cash payment" },
      ]}
    />
  );
}
