import { getCompany, getAdvanceLedger } from "@/lib/queries";
import { AdvanceLedger } from "@/components/advance-ledger";

export default async function CustomerAdvances({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const advances = await getAdvanceLedger(company.id, "CUSTOMER");

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Sales</span>
        <h1>Customer advances</h1>
        <span className="page-sub">
          Money customers have paid before any invoice existed — what is still
          held for them, and which bills the rest has gone to. It is a
          liability until it is applied, never a receivable.
        </span>
      </div>

      <AdvanceLedger side="CUSTOMER" advances={advances} status={status} />
    </>
  );
}
