import Link from "next/link";
import { getCompany, getNegativeStock } from "@/lib/queries";
import { reconcileNegativeStockAction } from "@/lib/actions";
import { ReconcileStock } from "@/components/reconcile-stock";
import { money } from "@/lib/format";

export default async function NegativeStock() {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const rows = (await getNegativeStock(company.id)) as unknown as Parameters<
    typeof ReconcileStock
  >[0]["rows"];
  const today = new Date().toISOString().slice(0, 10);
  const totalValue = rows.reduce((s, r) => s + Number(r.outstanding_value), 0);

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Inventory</span>
        <h1>Negative stock &mdash; pending reconciliation</h1>
        <span className="page-sub">
          Goods that went out before anything recorded them arriving. The stock
          was physically there; the paperwork was not, and someone confirmed
          that at the time. Each line is waiting for a receipt, or for the
          count below to bring the record back up to what is on the shelf.
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="empty">
          Nothing is pending. Recorded stock matches what has been issued.{" "}
          <Link href="/items/stock" style={{ color: "var(--brand)" }}>See stock on hand</Link>
        </div>
      ) : (
        <>
          <div className="kpis" style={{ marginBottom: "0.75rem" }}>
            <div className="kpi">
              <span className="kpi-label">Lines pending</span>
              <span className="kpi-value">{rows.length}</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">Value owed to inventory</span>
              <span className="kpi-value">{money(totalValue)}</span>
              <span className="kpi-note">at what the goods were charged out at</span>
            </div>
          </div>

          <ReconcileStock action={reconcileNegativeStockAction} rows={rows} today={today} />

          <div className="card" style={{ marginTop: "1rem" }}>
            <div className="card-body">
              <span className="page-sub">
                A goods receipt for the same item and warehouse settles these on
                its own, at whatever the supplier actually charged &mdash; and
                any difference from the price below goes to purchase price
                variance. Reconciling here instead is for stock that has been
                found and counted, where no receipt is coming.
              </span>
            </div>
          </div>
        </>
      )}
    </>
  );
}
