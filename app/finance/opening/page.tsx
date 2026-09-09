import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { getFinanceData, getFormData, createOpeningBatch } from "@/lib/actions";
import { getCompany, getOpeningBatch } from "@/lib/queries";
import { money } from "@/lib/db";
import { OpeningSetup } from "@/components/opening-setup";

/**
 * The cutover screen.
 *
 * Once a batch is posted this becomes a record of it rather than a form. A
 * company opens its books once, and a screen that still offers to do it
 * again is an invitation to double every balance on it.
 */
export default async function OpeningSetupPage() {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const posted = await getOpeningBatch(company.id);

  if (posted) {
    const { batch, documents } = posted as any;
    const total = (documents as any[]).reduce((s, d) => s + Number(d.gross_total), 0);
    return (
      <>
        <div className="page-head">
          <span className="eyebrow">Accounting</span>
          <h1>Opening balances</h1>
          <span className="page-sub">
            Posted as at {batch.cutover_date}. What the business held on the day
            it started using this system.
          </span>
        </div>

        <div className="tb-verdict ok" style={{ marginBottom: "1rem" }}>
          <CheckCircle2 size={16} aria-hidden="true" />
          <div>
            <strong>Opening balances are in.</strong>
            <div className="hint">
              A company opens its books once, so this cannot be entered again.
              Anything wrong with a figure below is corrected the way every
              other posted document is — by reversing it, not by re-opening.
            </div>
          </div>
        </div>

        <section>
          <div className="card">
            <div className="card-head">
              <h2>What it wrote</h2>
              <span className="page-sub">{documents.length} documents</span>
            </div>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Document</th><th>Type</th><th>Partner</th>
                    <th>Their reference</th><th className="r">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {(documents as any[]).map((d) => (
                    <tr key={d.id}>
                      <td className="code">
                        <Link href={`/documents/${d.id}`} style={{ color: "var(--brand)" }}>
                          {d.doc_no}
                        </Link>
                      </td>
                      <td>{d.doc_type === "OPENING_BALANCE" ? "Opening balance"
                          : d.doc_type === "SALES_INVOICE" ? "Opening receivable"
                          : "Opening payable"}</td>
                      <td>{d.partner_name ?? "—"}</td>
                      <td className="code">{d.reference ?? "—"}</td>
                      <td className="r">{money(d.gross_total)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr><td colSpan={4}>Total</td><td className="r">{money(total)}</td></tr>
                </tfoot>
              </table>
            </div>
          </div>
        </section>

        <div className="actions" style={{ marginTop: "1rem" }}>
          <Link href="/ledger" className="btn ghost">Check the trial balance</Link>
          <Link href="/items/stock" className="btn ghost">Check opening stock</Link>
        </div>
      </>
    );
  }

  const [finance, form] = await Promise.all([getFinanceData(), getFormData()]);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Accounting</span>
        <h1>Opening balances</h1>
        <span className="page-sub">
          What the business already had on the day it starts using this system:
          stock on the shelf, customers who owe you, suppliers you owe, and the
          cash and other balances. Entered once, together, so the stock ledger
          and the accounts start out agreeing.
        </span>
      </div>

      <OpeningSetup
        action={createOpeningBatch}
        items={form.items as never}
        locations={form.locations as never}
        branches={finance.branches as never}
        customers={form.customers as never}
        suppliers={form.suppliers as never}
        accounts={finance.accounts as never}
        today={today}
      />
    </>
  );
}
