import Link from "next/link";
import { getSettlementData, createSupplierPayment } from "@/lib/actions";
import { getCompany, getBranches } from "@/lib/queries";
import { SettlementForm } from "@/components/settlement-form";

export default async function PaySupplier({
  searchParams,
}: {
  searchParams: Promise<{ partner?: string; invoice?: string }>;
}) {
  const { partner, invoice } = await searchParams;
  const { partners, invoices, cashAccounts } = await getSettlementData("pay");
  const company = await getCompany();
  const branches = company ? await getBranches(company.id) : [];
  const today = new Date().toISOString().slice(0, 10);

  if (partners.length === 0 || cashAccounts.length === 0) {
    return (
      <>
        <div className="page-head">
          <span className="eyebrow">Purchases</span>
          <h1>Pay a supplier</h1>
        </div>
        <div className="alert">
          {partners.length === 0 && <div>No suppliers yet.</div>}
          {cashAccounts.length === 0 && (
            <div>No cash or bank account is marked as a till.</div>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Purchases</span>
        <h1>Pay a supplier</h1>
        <span className="page-sub">
          Choose a supplier to see their open bills, then apply what you are paying against each one.{" "}
          <Link href="/payables" style={{ color: "var(--brand)" }}>See everything outstanding</Link>
        </span>
      </div>

      <SettlementForm
        kind="pay"
        action={createSupplierPayment}
        partners={partners as never}
        invoices={invoices as never}
        cashAccounts={cashAccounts as never}
        branches={branches as never}
        today={today}
        initialPartnerId={partner}
        initialInvoiceId={invoice}
      />
    </>
  );
}
