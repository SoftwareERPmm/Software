import { Fragment } from "react";
import Link from "next/link";
import {
  ArrowRight, ArrowUpRight, Check, AlertTriangle, ChevronRight,
} from "lucide-react";
import { money } from "@/lib/db";
import {
  getCompany, getKpis, getHealth, getAging, getDocuments, getStock, getActionItems,
  getNegativeStock, getLowStock,
  getRevenueTrend, getTopItems, getTopCustomers, getOnboardingStatus,
} from "@/lib/queries";
import { RevenueBars } from "@/components/charts";

import { GettingStarted, needsGettingStarted } from "@/components/getting-started";

export default async function Dashboard() {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found. Run <span className="m">npm run db:seed</span>.</div>;

  const [kpis, health, aging, docs, stock, actionItems, revenueTrend, topItems, topCustomers,
         onboarding, negativeStock, lowStock] = await Promise.all([
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
    getNegativeStock(company.id),
    getLowStock(company.id),
  ]);

  const healthy = health.unbalanced === 0 && health.inventoryBreaks === 0 && health.trialBalance === 0;

  // Action required is exceptions only — blocked, overdue, or aged past a
  // reasonable window — never just "not at its final stage yet." A sales
  // order with nothing delivered is completely normal if the customer
  // wanted it next week; it only belongs here once its own "Needed by" date
  // has passed with something still outstanding. Same reasoning for GR/IR:
  // sitting open a few days is how the pattern works, not a problem — only
  // the aged subset (GRIR_AGE_DAYS in getActionItems) counts here.
  // Already fetched for the aging strip; no second query for one number.
  const noDueDate = (aging as unknown as { aging_bucket: string; invoices: number }[])
    .find((b) => b.aging_bucket === "NO_DUE_DATE")?.invoices ?? 0;

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
      href: "/finance/aging",
    },
    {
      n: actionItems.supplierBillsOverdue.n,
      label: `supplier bill${actionItems.supplierBillsOverdue.n === 1 ? "" : "s"} overdue`,
      detail: money(actionItems.supplierBillsOverdue.total),
      href: "/finance/aging?side=ap",
    },
    // These pointed at every order ever raised, which answers a different
    // question than the one being asked. "Two are overdue" and then a list
    // of two hundred is not a link to the two.
    {
      n: actionItems.salesOrders.overdue,
      label: `sales order${actionItems.salesOrders.overdue === 1 ? "" : "s"} overdue`,
      detail: "past its own Needed-by date",
      href: "/sales/orders?status=overdue",
    },
    {
      n: actionItems.purchaseOrders.overdue,
      label: `purchase order${actionItems.purchaseOrders.overdue === 1 ? "" : "s"} overdue`,
      detail: "past its own Needed-by date",
      href: "/purchases/orders?status=overdue",
    },
    /* Stock the books say is below zero. Not a paperwork problem: either goods
       left that were never received, or a receipt is missing, and until it is
       settled the cost of everything sold from that item is a guess. */
    {
      n: (negativeStock as unknown as unknown[]).length,
      label: `item${(negativeStock as unknown as unknown[]).length === 1 ? "" : "s"} at negative stock`,
      detail: "recorded below zero — a receipt is missing or goods left twice",
      href: "/inventory/negative-stock",
    },
    /* Out of stock, or under the reorder point somebody set for it. The one
       alert here that is about the future rather than a mistake already made. */
    {
      n: (lowStock as unknown as unknown[]).length,
      label: `item/warehouse pair${(lowStock as unknown as unknown[]).length === 1 ? "" : "s"} out of stock or below reorder`,
      detail: "reorder points are set per item and warehouse",
      href: "/items/stock",
    },
    /* Goods that left and were never billed. Stock is gone, the cost of sale
       is booked, and no receivable was ever raised — so the customer owes
       nothing, appears on no aging report, and nothing in the books looks
       wrong. It is a giveaway that nobody decided to make. */
    {
      n: actionItems.deliveriesUninvoiced.n,
      label: `deliver${actionItems.deliveriesUninvoiced.n === 1 ? "y" : "ies"} never invoiced`,
      detail: `oldest ${actionItems.deliveriesUninvoiced.oldestDays}d · ${money(actionItems.deliveriesUninvoiced.total)} given away unbilled`,
      href: "/sales/deliver?open=uninvoiced",
    },
    /* The mirror: billed, owed for, and still on the shelf. The ledger is
       right and the customer is the one who finds out. */
    {
      n: actionItems.invoicesUndelivered.n,
      label: `invoice${actionItems.invoicesUndelivered.n === 1 ? "" : "s"} billed but never delivered`,
      detail: `oldest ${actionItems.invoicesUndelivered.oldestDays}d · goods still in the warehouse`,
      href: "/sales/deliver?open=undelivered",
    },
    /* An invoice nobody agreed terms on. It cannot be chased, because there is
       no date it was supposed to be paid by — and it sits in aging under "No
       due date" rather than pretending to be current. */
    {
      n: noDueDate,
      label: `customer invoice${noDueDate === 1 ? "" : "s"} with no due date`,
      detail: "no terms agreed, so nothing can be called overdue",
      href: "/finance/aging",
    },
  ].filter((a) => a.n > 0);

  // Work in progress is the neutral counterpart — normal open business, no
  // threshold, nothing implying anyone forgot anything.
  // "Open" is not used here, deliberately. On the order lists it is a status
  // with a narrower meaning — nothing fulfilled at all — while this panel
  // counts every order with goods still to come, partly received ones
  // included. Saying "2 purchase orders open" next to a list showing none of
  // them as Open is the same word meaning two things, and it reads as a bug
  // in the figure rather than in the wording. These say what they count.
  const orderSplit = (o: { notStarted: number; partial: number }) =>
    o.notStarted > 0 && o.partial > 0
      ? `${o.notStarted} not started · ${o.partial} partly done`
      : o.partial > 0 ? "partly done" : "none started yet";

  const wip = [
    {
      n: actionItems.salesOrders.open,
      label: "sales orders awaiting delivery",
      detail: orderSplit(actionItems.salesOrders),
      href: "/documents?type=SALES_ORDER",
    },
    { n: actionItems.openDeliveries, label: "deliveries pending invoice", href: "/documents?type=DELIVERY" },
    {
      n: actionItems.purchaseOrders.open,
      label: "purchase orders awaiting goods",
      detail: orderSplit(actionItems.purchaseOrders),
      href: "/documents?type=PURCHASE_ORDER",
    },
    { n: actionItems.goodsReceipts.open, label: "goods receipts pending invoice", href: "/documents?type=GOODS_RECEIPT&open=grir" },
    { n: Number(kpis.ar.n), label: "unpaid customer invoices", href: "/receivables" },
    { n: Number(kpis.ap.n), label: "unpaid supplier bills", href: "/payables" },
  ];

  // ---- figures the design shows, all derived from the data above ---------

  const n = (v: unknown) => Number(v ?? 0);
  /**
   * Figures on this screen carry their currency, as the design shows them.
   * Taken from the company rather than written in: this app is single-company
   * but not single-currency, and "MMK" typed into a template is a lie waiting
   * for the first business that keeps its books in anything else.
   */
  const cur = (v: unknown) => `${company.base_currency} ${money(v as never)}`;
  const trend = revenueTrend as unknown as { month: string; revenue: number | string }[];
  const revenueTotal = trend.reduce((t, r) => t + n(r.revenue), 0);
  // Month on month, as the reference labels it. Null where there is no
  // previous month to compare with, or where it was zero — a rise from
  // nothing is not a percentage, and "+∞%" is not a figure anybody can use.
  const thisMonth = n(trend.at(-1)?.revenue);
  const lastMonth = n(trend.at(-2)?.revenue);
  const change = lastMonth > 0 ? ((thisMonth - lastMonth) / lastMonth) * 100 : null;

  const items = topItems as unknown as
    { id: string; name: string; qty: number | string; revenue: number | string }[];

  const urgent = actions.reduce((t, a) => t + a.n, 0);

  const today = new Date().toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long",
  });

  /** A KPI's badge: what this figure is doing, said from the figure itself. */
  const kpiCards = [
    {
      label: "Inventory value",
      value: cur(kpis.stock.value),
      note: `${money(kpis.stock.qty)} units on hand`,
      badge: n(kpis.stock.value) > 0
        ? { text: "On hand", tint: "var(--brand)" }
        : { text: "Nothing in stock", tint: "var(--muted)" },
    },
    {
      label: "Receivables",
      value: cur(kpis.ar.total),
      note: n(kpis.ar.n) === 0
        ? "No outstanding invoices"
        : `${kpis.ar.n} open invoice${n(kpis.ar.n) === 1 ? "" : "s"}`,
      badge: actionItems.customerInvoicesOverdue.n > 0
        ? { text: `${actionItems.customerInvoicesOverdue.n} overdue`, tint: "var(--bad)" }
        : n(kpis.ar.n) === 0
          ? { text: "All collected", tint: "#3B6FD4" }
          : { text: "None overdue", tint: "#3B6FD4" },
    },
    {
      label: "Payables",
      value: cur(kpis.ap.total),
      note: n(kpis.ap.n) === 0
        ? "No supplier bills due"
        : `${kpis.ap.n} supplier bill${n(kpis.ap.n) === 1 ? "" : "s"} due`,
      badge: actionItems.supplierBillsOverdue.n > 0
        ? { text: `${actionItems.supplierBillsOverdue.n} overdue`, tint: "var(--bad)" }
        : n(kpis.ap.n) === 0
          ? { text: "Nothing owed", tint: "var(--muted)" }
          : { text: "None overdue", tint: "var(--warn)" },
    },
    {
      label: "Cash balance",
      value: cur(kpis.cash.total),
      note: "Cash + bank accounts",
      badge: n(kpis.cash.total) === 0
        ? { text: "No movement", tint: "#6C5CE0" }
        : { text: "Available", tint: "#6C5CE0" },
    },
  ];

  // Money that moved before any invoice did. Kept from the previous
  // dashboard — it has nowhere else to appear, and it only shows when there
  // is some, so it does not pad the row with a zero.
  if (n(kpis.advances.customer) > 0 || n(kpis.advances.supplier) > 0) {
    kpiCards.push({
      label: "On account",
      value: cur(n(kpis.advances.customer) + n(kpis.advances.supplier)),
      note: "Paid before invoicing",
      badge: { text: "Unapplied", tint: "#0E8A8A" },
    });
  }

  /** The two pipelines, each stage counted from what is actually open. */
  const purchaseFlow = [
    { n: actionItems.purchaseOrders.open, name: "Orders", sub: "Awaiting goods",
      href: "/documents?type=PURCHASE_ORDER" },
    { n: actionItems.goodsReceipts.open, name: "Receiving", sub: "Awaiting bill",
      href: "/documents?type=GOODS_RECEIPT&open=grir" },
    { n: actionItems.purchaseInvoicesAwaitingGoods.open ?? 0, name: "Billing",
      sub: "Awaiting goods", href: "/documents?type=PURCHASE_INVOICE&open=grir" },
    { n: n(kpis.ap.n), name: "Payment", sub: "Unpaid bills", href: "/payables" },
  ];
  const salesFlow = [
    { n: actionItems.salesOrders.open, name: "Orders", sub: "Awaiting delivery",
      href: "/documents?type=SALES_ORDER" },
    { n: actionItems.openDeliveries, name: "Delivery", sub: "Awaiting invoice",
      href: "/documents?type=DELIVERY" },
    { n: n(kpis.ar.n), name: "Invoicing", sub: "Unpaid invoices", href: "/receivables" },
    { n: actionItems.customerInvoicesOverdue.n, name: "Collection", sub: "Overdue",
      href: "/receivables?status=overdue" },
  ];

  const checks = [
    { label: "Trial balance", value: health.trialBalance === 0 ? "Balanced" : cur(health.trialBalance),
      ok: health.trialBalance === 0 },
    { label: "Journal integrity", value: `${health.unbalanced} unbalanced entr${health.unbalanced === 1 ? "y" : "ies"}`,
      ok: health.unbalanced === 0 },
    { label: "Inventory ↔ GL",
      value: health.inventoryBreaks === 0 ? `Reconciled · ${cur(kpis.stock.value)}` : `${health.inventoryBreaks} break${health.inventoryBreaks === 1 ? "" : "s"}`,
      ok: health.inventoryBreaks === 0 },
    { label: "AR / AP ↔ GL", value: "Reconciled", ok: true },
  ];

  const TYPE_MARK: Record<string, { short: string; tint: string }> = {
    GOODS_RECEIPT: { short: "GR", tint: "#6C5CE0" },
    PURCHASE_ORDER: { short: "PO", tint: "#3B6FD4" },
    PURCHASE_INVOICE: { short: "PI", tint: "var(--warn)" },
    SUPPLIER_PAYMENT: { short: "PAY", tint: "var(--brand)" },
    SALES_ORDER: { short: "SO", tint: "#3B6FD4" },
    DELIVERY: { short: "DO", tint: "#6C5CE0" },
    SALES_INVOICE: { short: "SI", tint: "var(--warn)" },
    CUSTOMER_RECEIPT: { short: "REC", tint: "var(--brand)" },
    STOCK_TRANSFER: { short: "TR", tint: "var(--muted)" },
    STOCK_ADJUSTMENT: { short: "ADJ", tint: "var(--muted)" },
  };
  const recent = (docs as unknown as {
    id: string; doc_type: string; doc_no: string | null; partner_name: string | null;
    gross_total: number | string; posted_at: string | null; posting_date: string;
  }[]).slice(0, 5);
  const since = (at: string | null, on: string) => {
    const t = at ? new Date(at).getTime() : new Date(on).getTime();
    const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    return new Date(on).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  };

  return (
    <div className="dash">
      <div className="dash-head">
        <div>
          <h1>Dashboard</h1>
          <span className="dash-sub">
            {today} · {company.name}
            {company.name_my ? ` · ${company.name_my}` : ""}
          </span>
        </div>
        <div className="dash-actions">
          {/* States the period the figures actually cover. The reference
              draws a dropdown; nothing behind it filters anything yet, and a
              control that does nothing is worse than a label that is true. */}
          <span className="dash-chip">Last 6 months</span>
          <Link href="/documents" className="dash-chip solid">
            New document <ChevronRight size={14} aria-hidden="true" />
          </Link>
        </div>
      </div>

      <div className="dash-cards">
        {kpiCards.map((k) => (
          <div key={k.label} className="dash-card dash-card-pad dash-kpi">
            {/* No colour dot. Five of them made a row of markers that keyed
                to nothing — no legend, no chart, no repeat anywhere else on
                the page — so the eye read them as meaning something and found
                they meant only "this is a card". The label says what it is. */}
            <span className="dash-kpi-label">{k.label}</span>
            <span className="dash-kpi-value">{k.value}</span>
            <span className="dash-kpi-note">{k.note}</span>
            <span className="dash-badge" style={{
              color: k.badge.tint,
              background: `color-mix(in srgb, ${k.badge.tint} 10%, transparent)`,
            }}>
              {k.badge.text}
            </span>
          </div>
        ))}
      </div>

      <div className={`dash-banner${urgent > 0 ? " warn" : ""}`}>
        <span className="dash-banner-mark" aria-hidden="true">
          {urgent > 0 ? <AlertTriangle size={16} /> : <Check size={16} />}
        </span>
        <div>
          <strong>
            {urgent > 0
              ? `${urgent} thing${urgent === 1 ? "" : "s"} need${urgent === 1 ? "s" : ""} attention`
              : "No urgent actions"}
          </strong>
          <span className="dash-sub" style={{ display: "block", color: "var(--muted)" }}>
            {urgent > 0 ? (
              /* Each count goes where that count is dealt with. Every action
                 already carried its own href and the summary printed them as
                 flat text, so the only way in was "view all alerts" — which
                 opened the unfiltered document list and left the reader to
                 find, among everything the company has ever posted, the five
                 invoices the banner had just counted for them. */
              actions.map((a, i) => (
                <Fragment key={a.href}>
                  {i > 0 && " · "}
                  <Link href={a.href} className="dash-alert-link">
                    {a.n} {a.label}
                  </Link>
                </Fragment>
              ))
            ) : "Invoices, orders and inventory checks are up to date."}
          </span>
        </div>
      </div>

      {/* Setup is the exception to the reference layout: it only exists until
          the company is trading, so it sits under the figures rather than
          pushing them below the fold. */}
      {needsGettingStarted(onboarding) && <GettingStarted status={onboarding} />}

      <div className="dash-card dash-card-pad" style={{ marginBottom: "var(--dash-gap)" }}>
        <div className="dash-section-head">
          <div>
            <h2>Business flow</h2>
            <span className="dash-sub">Live document progress across purchasing and sales</span>
          </div>
        </div>

        {[{ label: "Purchases", flow: purchaseFlow }, { label: "Sales", flow: salesFlow }]
          .map((side, si) => (
          <div key={side.label}>
            {si > 0 && <div className="dash-flow-sep" />}
            <span className="dash-flow-label">{side.label}</span>
            <div className="dash-flow-row">
              {/* The arrow leads its step rather than trailing it, so a row
                  that wraps on a narrow screen carries the arrow down as a
                  continuation instead of leaving one pointing at nothing. */}
              {side.flow.map((step, i) => (
                <div key={step.name} className="dash-flow-cell">
                  {i > 0 && (
                    <ArrowRight size={18} className="dash-flow-arrow" aria-hidden="true" />
                  )}
                  <Link href={step.href} className="dash-flow-step">
                    <span className="dash-flow-n" style={
                      step.n > 0
                        ? { background: "var(--brand)", color: "var(--brand-fg)" }
                        : { background: "color-mix(in srgb, var(--line) 40%, transparent)",
                            color: "var(--muted)" }
                    }>{step.n}</span>
                    <span style={{ minWidth: 0 }}>
                      <span className="dash-flow-name" style={{ display: "block" }}>{step.name}</span>
                      <span className="dash-flow-sub">{step.sub}</span>
                    </span>
                  </Link>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="dash-split">
        <div className="dash-card dash-card-pad">
          <div className="dash-section-head">
            <h2>Revenue</h2>
            <span className="dash-chip">Revenue · 6 months</span>
          </div>
          <div className="dash-figure">
            {/* Six months of sales net of returns can land below zero, and
                when it does the minus sign is the whole message — easy to
                read past in a figure this size, and not at all in red. */}
            <span className="dash-figure-value" data-negative={revenueTotal < 0}>
              {cur(revenueTotal)}
            </span>
            {change !== null && (
              <span className="dash-badge" style={{
                color: change >= 0 ? "var(--ok)" : "var(--bad)",
                background: `color-mix(in srgb, ${change >= 0 ? "var(--ok)" : "var(--bad)"} 10%, transparent)`,
              }}>
                <ArrowUpRight size={13} style={{
                  transform: change >= 0 ? "none" : "scaleY(-1)",
                }} aria-hidden="true" />
                {Math.abs(change).toFixed(1)}%
              </span>
            )}
          </div>
          <span className="dash-kpi-note">
            {change === null
              ? "No earlier month to compare with"
              : "Compared with previous month"}
          </span>
          <div style={{ marginTop: "1.25rem" }}>
            {revenueTotal === 0
              ? <div className="empty">No revenue posted in the last six months.</div>
              : <RevenueBars data={trend} />}
          </div>
        </div>

        <div className="dash-card dash-card-pad dash-rank-card">
          <div className="dash-section-head">
            <h2>Top-selling items</h2>
            <span className="dash-chip">By revenue</span>
          </div>
          {items.length === 0 ? (
            <div className="empty">No sales invoices yet.</div>
          ) : (
            <>
              <div className="dash-rank">
                {items.slice(0, 4).map((it, i) => (
                  <div key={it.id} className="dash-rank-row">
                    <span className="dash-rank-n">{i + 1}</span>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ fontWeight: 500, display: "block" }}>{it.name}</span>
                      <span className="dash-kpi-note">{money(it.qty)} units</span>
                    </span>
                    <span style={{ fontWeight: 700, whiteSpace: "nowrap" }}>{cur(it.revenue)}</span>
                  </div>
                ))}
              </div>
              <Link href="/items" className="dash-banner-link dash-rank-more">
                View item performance <ArrowRight size={14} style={{ verticalAlign: "-2px" }} />
              </Link>
            </>
          )}
        </div>
      </div>

      <div className="dash-card dash-card-pad" style={{ marginBottom: "var(--dash-gap)" }}>
        <div className="dash-section-head">
          <div>
            <h2>Accounting health</h2>
            <span className="dash-sub">
              Automated checks between operational ledgers and the general ledger
            </span>
          </div>
          <span className="dash-badge" style={{
            color: healthy ? "var(--ok)" : "var(--bad)",
            background: `color-mix(in srgb, ${healthy ? "var(--ok)" : "var(--bad)"} 10%, transparent)`,
            letterSpacing: "var(--track-caps)", textTransform: "uppercase",
          }}>
            {healthy ? <Check size={13} /> : <AlertTriangle size={13} />}
            {healthy ? "Healthy" : "Needs attention"}
          </span>
        </div>
        <div className="dash-health">
          {checks.map((c) => (
            <div key={c.label} className={`dash-health-item${c.ok ? "" : " bad"}`}>
              <span className="dash-health-mark" aria-hidden="true">
                {c.ok ? <Check size={14} /> : <AlertTriangle size={14} />}
              </span>
              <span style={{ minWidth: 0 }}>
                <span className="dash-kpi-note" style={{ display: "block" }}>{c.label}</span>
                <strong>{c.value}</strong>
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="dash-card dash-card-pad">
        <div className="dash-section-head">
          <h2>Recent activity</h2>
          <Link href="/documents" className="dash-banner-link">
            View all documents <ArrowRight size={14} style={{ verticalAlign: "-2px" }} />
          </Link>
        </div>
        {recent.length === 0 ? (
          <div className="empty">Nothing posted yet.</div>
        ) : (
          <div className="dash-activity">
            {recent.map((d) => {
              const mark = TYPE_MARK[d.doc_type] ?? { short: "DOC", tint: "var(--muted)" };
              return (
                <Link key={d.id} href={`/documents/${d.id}`} className="dash-activity-row">
                  <span className="dash-activity-mark" style={{
                    color: mark.tint,
                    background: `color-mix(in srgb, ${mark.tint} 10%, transparent)`,
                  }}>{mark.short}</span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ fontWeight: 500, display: "block" }}>{d.doc_no ?? "—"}</span>
                    <span className="dash-kpi-note">
                      {d.doc_type.toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())}
                      {d.partner_name ? ` · ${d.partner_name}` : ""}
                    </span>
                  </span>
                  <span className="dash-activity-right">
                    <span>
                      <span style={{ fontWeight: 700, display: "block" }}>{cur(d.gross_total)}</span>
                      <span className="dash-kpi-note">{since(d.posted_at, d.posting_date)}</span>
                    </span>
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
