import Link from "next/link";
import { Boxes, Receipt, Wallet, Banknote, AlertTriangle } from "lucide-react";
import { money } from "@/lib/db";
import {
  getCompany, getKpis, getHealth, getAging, getDocuments, getStock, getActionItems,
  getRevenueTrend, getTopItems, getTopCustomers, getOnboardingStatus,
} from "@/lib/queries";
import { RevenueTrendChart, RankedBarChart } from "@/components/charts";
import { ActivityFeed, type ActivityDoc } from "@/components/activity-feed";
import { GettingStarted, needsGettingStarted } from "@/components/getting-started";

export default async function Dashboard() {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found. Run <span className="m">npm run db:seed</span>.</div>;

  const [kpis, health, aging, docs, stock, actionItems, revenueTrend, topItems, topCustomers, onboarding] = await Promise.all([
    getKpis(company.id),
    getHealth(company.id),
    getAging(company.id),
    getDocuments(company.id),
    getStock(company.id),
    getActionItems(company.id),
    getRevenueTrend(company.id),
    getTopItems(company.id),
    getTopCustomers(company.id),
    getOnboardingStatus(company.id),
  ]);

  const healthy = health.unbalanced === 0 && health.inventoryBreaks === 0 && health.trialBalance === 0;

  // Action required is exceptions only — blocked, overdue, or aged past a
  // reasonable window — never just "not at its final stage yet." A sales
  // order with nothing delivered is completely normal if the customer
  // wanted it next week; it only belongs here once its own "Needed by" date
  // has passed with something still outstanding. Same reasoning for GR/IR:
  // sitting open a few days is how the pattern works, not a problem — only
  // the aged subset (GRIR_AGE_DAYS in getActionItems) counts here.
  const actions = [
    {
      n: actionItems.goodsReceipts.aged,
      label: `goods receipt${actionItems.goodsReceipts.aged === 1 ? "" : "s"}, supplier invoice missing`,
      detail: `oldest ${actionItems.goodsReceipts.oldestDays}d · ${money(actionItems.goodsReceipts.agedTotal)}`,
      href: "/documents?type=GOODS_RECEIPT&open=grir",
    },
    {
      n: actionItems.purchaseInvoicesAwaitingGoods.aged,
      label: `supplier invoice${actionItems.purchaseInvoicesAwaitingGoods.aged === 1 ? "" : "s"}, goods overdue to arrive`,
      detail: `oldest ${actionItems.purchaseInvoicesAwaitingGoods.oldestDays}d · ${money(actionItems.purchaseInvoicesAwaitingGoods.agedTotal)}`,
      href: "/documents?type=PURCHASE_INVOICE&open=grir",
    },
    {
      n: actionItems.customerInvoicesOverdue.n,
      label: `customer invoice${actionItems.customerInvoicesOverdue.n === 1 ? "" : "s"} overdue`,
      detail: money(actionItems.customerInvoicesOverdue.total),
      href: "/receivables?status=overdue",
    },
    {
      n: actionItems.supplierBillsOverdue.n,
      label: `supplier bill${actionItems.supplierBillsOverdue.n === 1 ? "" : "s"} overdue`,
      detail: money(actionItems.supplierBillsOverdue.total),
      href: "/payables?status=overdue",
    },
    {
      n: actionItems.salesOrders.overdue,
      label: `sales order${actionItems.salesOrders.overdue === 1 ? "" : "s"} overdue`,
      detail: "past its own Needed-by date",
      href: "/documents?type=SALES_ORDER",
    },
    {
      n: actionItems.purchaseOrders.overdue,
      label: `purchase order${actionItems.purchaseOrders.overdue === 1 ? "" : "s"} overdue`,
      detail: "past its own Needed-by date",
      href: "/documents?type=PURCHASE_ORDER",
    },
  ].filter((a) => a.n > 0);

  // Work in progress is the neutral counterpart — normal open business, no
  // threshold, nothing implying anyone forgot anything.
  const wip = [
    { n: actionItems.salesOrders.open, label: "sales orders open", href: "/documents?type=SALES_ORDER" },
    { n: actionItems.openDeliveries, label: "deliveries pending invoice", href: "/documents?type=DELIVERY" },
    { n: actionItems.purchaseOrders.open, label: "purchase orders open", href: "/documents?type=PURCHASE_ORDER" },
    { n: actionItems.goodsReceipts.open, label: "goods receipts pending invoice", href: "/documents?type=GOODS_RECEIPT&open=grir" },
    { n: Number(kpis.ar.n), label: "unpaid customer invoices", href: "/receivables" },
    { n: Number(kpis.ap.n), label: "unpaid supplier bills", href: "/payables" },
  ];

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Dashboard</span>
        <h1>{company.name}</h1>
        <span className="page-sub">
          {company.name_my ? `${company.name_my} · ` : ""}Financial year 2026-27 · all figures in {company.base_currency}
        </span>
      </div>

      {needsGettingStarted(onboarding) && <GettingStarted status={onboarding} />}

      <div className="kpis">
        <div className="kpi">
          <span className="kpi-label"><Boxes size={13} /> Stock value</span>
          <span className="kpi-value">{money(kpis.stock.value)}</span>
          <span className="kpi-note">{money(kpis.stock.qty)} units on hand</span>
        </div>
        <div className="kpi">
          <span className="kpi-label"><Receipt size={13} /> Receivables</span>
          <span className="kpi-value">{money(kpis.ar.total)}</span>
          <span className="kpi-note">{kpis.ar.n} open invoice{kpis.ar.n === 1 ? "" : "s"}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label"><Wallet size={13} /> Payables</span>
          <span className="kpi-value">{money(kpis.ap.total)}</span>
          <span className="kpi-note">{kpis.ap.n} open bill{kpis.ap.n === 1 ? "" : "s"}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label"><Banknote size={13} /> Cash at bank</span>
          <span className="kpi-value">{money(kpis.cash.total)}</span>
          <span className="kpi-note">cash and KBZ</span>
        </div>
      </div>

      <section>
        <div className="card">
          <div className="card-head">
            <h2><AlertTriangle size={15} style={{ verticalAlign: "-2px", marginRight: "0.3rem" }} /> Action required</h2>
            {actions.length > 0 && (
              <span className="page-sub">
                {actions.length} thing{actions.length === 1 ? "" : "s"} genuinely need attention
              </span>
            )}
          </div>
          <div className="card-body">
            {actions.length === 0 ? (
              <p className="page-sub">Nothing overdue, aged, or blocked right now.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
                {actions.map((a) => (
                  <Link
                    key={a.href + a.label}
                    href={a.href}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      padding: "0.5rem 0.75rem", borderRadius: "8px", border: "1px solid var(--line)",
                    }}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                      <span className="pill overdue">{a.n}</span>
                      <span>
                        {a.label}
                        {a.detail && (
                          <span className="page-sub" style={{ marginLeft: "0.5rem" }}>{a.detail}</span>
                        )}
                      </span>
                    </span>
                    <span className="m" style={{ color: "var(--brand)" }}>View →</span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Work in progress</h2>
            <span className="page-sub">normal, in-flight business — nothing here needs a decision</span>
          </div>
          <div className="card-body">
            <div className="wip-grid">
              {wip.map((w) => (
                <Link key={w.href + w.label} href={w.href} className="wip-item">
                  <span className="pill">{w.n}</span>
                  <span>{w.label}</span>
                </Link>
              ))}
            </div>
          </div>
        </div>
      </section>

      <div className="grid2">
        <section>
          <div className="card">
            <div className="card-head">
              <h2>Revenue, last 6 months</h2>
            </div>
            <div className="card-body">
              <RevenueTrendChart data={revenueTrend as never} />
            </div>
          </div>
        </section>

        <section>
          <div className="card">
            <div className="card-head">
              <h2>Top-selling items</h2>
              <span className="page-sub">by revenue, last 6 months</span>
            </div>
            <div className="card-body">
              {topItems.length === 0 ? (
                <div className="empty">No sales invoices yet.</div>
              ) : (
                <RankedBarChart
                  data={(topItems as any[]).map((i) => ({ label: i.name, value: i.revenue }))}
                />
              )}
            </div>
          </div>
        </section>
      </div>

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Top customers</h2>
            <span className="page-sub">by revenue, last 6 months</span>
          </div>
          <div className="card-body">
            {topCustomers.length === 0 ? (
              <div className="empty">No sales invoices yet.</div>
            ) : (
              <RankedBarChart
                data={(topCustomers as any[]).map((c) => ({ label: c.name, value: c.revenue }))}
                height={Math.max(120, (topCustomers as any[]).length * 34)}
              />
            )}
          </div>
        </div>
      </section>

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Ledger health</h2>
            <span className={`pill ${healthy ? "ok" : "overdue"}`}>{healthy ? "All checks pass" : "Attention needed"}</span>
          </div>
          <div className="card-body">
            <div className="health">
              <span className="health-item">
                <span className={`dot ${health.trialBalance === 0 ? "ok" : "bad"}`} />
                Trial balance nets to {money(health.trialBalance)}
              </span>
              <span className="health-item">
                <span className={`dot ${health.unbalanced === 0 ? "ok" : "bad"}`} />
                {health.unbalanced} unbalanced entries
              </span>
              <span className="health-item">
                <span className={`dot ${health.inventoryBreaks === 0 ? "ok" : "bad"}`} />
                Inventory account agrees with the stock ledger
              </span>
            </div>
          </div>
        </div>
      </section>

      <div className="grid2">
        <section>
          <div className="card">
            <div className="card-head"><h2>Receivables aging</h2></div>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr><th>Bucket</th><th className="r">Invoices</th><th className="r">Outstanding</th></tr>
                </thead>
                <tbody>
                  {aging.map((a: any) => (
                    <tr key={a.aging_bucket}>
                      <td>
                        <span className={`pill ${a.aging_bucket === "CURRENT" ? "ok" : "overdue"}`}>
                          {a.aging_bucket === "CURRENT" ? "Current" : `${a.aging_bucket} days`}
                        </span>
                      </td>
                      <td className="r">{a.invoices}</td>
                      <td className="r">{money(a.total)}</td>
                    </tr>
                  ))}
                  {aging.length === 0 && <tr><td colSpan={3} className="empty">Nothing outstanding</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section>
          <div className="card">
            <div className="card-head"><h2>Stock on hand</h2></div>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr><th>Item</th><th>Location</th><th className="r">Qty</th><th className="r">Value</th></tr>
                </thead>
                <tbody>
                  {stock.map((s: any, i: number) => (
                    <tr key={i}>
                      <td className="code">{s.item_code}</td>
                      <td className="code">{s.location_code}</td>
                      <td className="r">{money(s.qty_on_hand)}</td>
                      <td className="r">{money(s.value_on_hand)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3}>Total</td>
                    <td className="r">{money(kpis.stock.value)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </section>
      </div>

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Recent activity</h2>
            <Link href="/documents" className="m" style={{ color: "var(--brand)" }}>View all →</Link>
          </div>
          <div className="card-body">
            <ActivityFeed docs={docs.slice(0, 10) as unknown as ActivityDoc[]} />
          </div>
        </div>
      </section>
    </>
  );
}
