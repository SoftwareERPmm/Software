import { getCompany, getAdvanceLedger } from "@/lib/queries";
import { AdvanceLedger } from "@/components/advance-ledger";

export default async function SupplierAdvances({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const advances = await getAdvanceLedger(company.id, "SUPPLIER");

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Purchases</span>
        <h1>Supplier advances</h1>
        <span className="page-sub">
          Money paid to suppliers before they billed for anything — what they
          still owe us in goods, and which bills the rest has gone to. It is an
          asset until it is applied, never a payable.
        </span>
      </div>

      <AdvanceLedger side="SUPPLIER" advances={advances} status={status} />
    </>
  );
}
