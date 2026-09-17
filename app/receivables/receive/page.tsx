import Link from "next/link";
import { getSettlementData, createCustomerReceipt } from "@/lib/actions";
import { getCompany, getBranches } from "@/lib/queries";
import { SettlementForm } from "@/components/settlement-form";
import { ErpCrumbs } from "@/components/erp-worklist";
import { HelpHint } from "@/components/help-hint";

export default async function ReceiveFromCustomer({
  searchParams,
}: {
  searchParams: Promise<{ partner?: string; invoice?: string }>;
}) {
  const { partner, invoice } = await searchParams;
  const { partners, invoices, cashAccounts } = await getSettlementData("receive");
  const company = await getCompany();
  const branches = company ? await getBranches(company.id) : [];
  const today = new Date().toISOString().slice(0, 10);

  if (partners.length === 0 || cashAccounts.length === 0) {
    return (
      <>
        <ErpCrumbs steps={[
          { label: "Receivables", href: "/receivables" },
          { label: "Receive from a customer" },
        ]} />
        <div className="page-head">
          <h1>Receive from a customer</h1>
        </div>
        <div className="alert">
          {partners.length === 0 && <div>No customers yet.</div>}
          {cashAccounts.length === 0 && (
            <div>No cash or bank account is marked as a till.</div>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <ErpCrumbs steps={[
        { label: "Receivables", href: "/receivables" },
        { label: "Receive from a customer" },
      ]} />
      <div className="page-head">
        <h1>Receive from a customer</h1>
        <HelpHint>
          Choose a customer to see their open invoices, then apply what they have paid against each one.{" "}
          <Link href="/receivables" style={{ color: "var(--brand)" }}>See everything outstanding</Link>
        </HelpHint>
      </div>

      <SettlementForm
        kind="receive"
        action={createCustomerReceipt}
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
