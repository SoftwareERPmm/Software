import { getCompany, getAdvanceLedger } from "@/lib/queries";
import { sql } from "@/lib/db";
import { AdvanceLedger } from "@/components/advance-ledger";
import { HelpHint } from "@/components/help-hint";

export default async function SupplierAdvances({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const [advances, cashAccounts, [today]] = await Promise.all([
    getAdvanceLedger(company.id, "SUPPLIER"),
    // Where a refund can go through. The same accounts a receipt or a
    // payment may use, because a refund is money moving the same way.
    sql`select id, code, name from account
         where company_id = ${company.id} and is_cash_account
           and is_postable and is_active order by code` as unknown as
      Promise<{ id: string; code: string; name: string }[]>,
    sql`select to_char(current_date, 'YYYY-MM-DD') as d` as unknown as Promise<{ d: string }[]>,
  ]);

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Purchases</span>
        <h1>Supplier advances</h1>
        <HelpHint>
          Money paid to suppliers before they billed for anything — what they
          still owe us in goods, and which bills the rest has gone to. It is an
          asset until it is applied, never a payable.
        </HelpHint>
      </div>

      <AdvanceLedger side="SUPPLIER" advances={advances} status={status}
        cashAccounts={cashAccounts} today={today.d} />
    </>
  );
}
