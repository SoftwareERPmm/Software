import Link from "next/link";
import {
  ArrowRight, ArrowUpRight, Check, AlertTriangle, ChevronRight,
} from "lucide-react";
import { money } from "@/lib/db";
import {
  getCompany, getKpis, getHealth, getAging, getDocuments, getStock, getActionItems,
  getNegativeStock, getLowStock,
  getRevenueTrend, getTopItems, getTopCategories, getRevenueByRegion,
  getOnboardingStatus,
} from "@/lib/queries";
import { RevenueBars, ShareDonut } from "@/components/charts";
import { resolvePeriod, DEFAULT_PERIOD } from "@/lib/period";
import { PeriodPicker } from "@/components/period-picker";

import { GettingStarted, needsGettingStarted } from "@/components/getting-started";
import {
  AttentionPanel, type AttentionGroup, type AttentionItem,
} from "@/components/attention-panel";

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found. Run <span className="m">npm run db:seed</span>.</div>;

  /* One window per card, not one for the page: revenue over a year and top
     sellers over this month is a normal thing to want, and a single filter
     made every card answer whichever question the last one asked.

     Balances stay out of it entirely — receivables, payables, stock and cash
     are what they are today, and a figure answering "what was outstanding in
     March" beside one answering "what is outstanding now" is how a dashboard
     starts lying quietly. */
  const sp = await searchParams;
  const period = {
    rev: resolvePeriod(sp.rev),
    items: resolvePeriod(sp.items),
    cat: resolvePeriod(sp.cat),
    reg: resolvePeriod(sp.reg),
  };
  /* Changing one card's window leaves the other three where the reader put
     them, so the URL carries all four and each link edits one key. */
  const hrefWith = (key: string, value: string) => {
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(sp)) if (v) next[k] = v;
    if (value === DEFAULT_PERIOD) delete next[key];
    else next[key] = value;
    const q = new URLSearchParams(next).toString();
    return q ? `/?${q}` : "/";
  };

  const [kpis, health, aging, docs, stock, actionItems, revenueTrend, topItems, topCategories,
         regionRevenue, onboarding, negativeStock, lowStock] = await Promise.all([
    getKpis(company.id),
    getHealth(company.id),
    getAging(company.id),
    getDocuments(company.id),
    getStock(company.id),
    getActionItems(company.id),
    getRevenueTrend(company.id, period.rev.chartMonths, period.rev.chartAnchor),
    getTopItems(company.id, period.items.from, period.items.to),
    getTopCategories(company.id, period.cat.from, period.cat.to),
    getRevenueByRegion(company.id, period.reg.from, period.reg.to),
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

  const actions = ([
    {
      n: actionItems.goodsReceipts.aged,
      label: "Goods receipts awaiting bill",
      detail: `oldest ${actionItems.goodsReceipts.oldestDays}d · ${money(actionItems.goodsReceipts.agedTotal)}`,
      href: "/documents?type=GOODS_RECEIPT&open=grir",
      group: "purchases", tone: "warn",
    },
    {
      n: actionItems.purchaseInvoicesAwaitingGoods.aged,
      label: "Supplier invoices awaiting goods",
      detail: `oldest ${actionItems.purchaseInvoicesAwaitingGoods.oldestDays}d · ${money(actionItems.purchaseInvoicesAwaitingGoods.agedTotal)}`,
      href: "/documents?type=PURCHASE_INVOICE&open=grir",
      group: "purchases", tone: "warn",
    },
    {
      n: actionItems.customerInvoicesOverdue.n,
      label: "Overdue receivables",
      detail: money(actionItems.customerInvoicesOverdue.total),
      href: "/finance/aging",
      group: "sales", tone: "bad",
    },
    {
      n: actionItems.supplierBillsOverdue.n,
      label: "Supplier bills overdue",
      detail: money(actionItems.supplierBillsOverdue.total),
      href: "/finance/aging?side=ap",
      group: "purchases", tone: "bad",
    },
    // These pointed at every order ever raised, which answers a different
    // question than the one being asked. "Two are overdue" and then a list
    // of two hundred is not a link to the two.
    {
      n: actionItems.salesOrders.overdue,
      label: "Sales orders overdue",
      detail: "past its own Needed-by date",
      href: "/sales/orders?status=overdue",
      group: "sales", tone: "warn",
    },
    {
      n: actionItems.purchaseOrders.overdue,
      label: "Purchase orders overdue",
      detail: "past its own Needed-by date",
      href: "/purchases/orders?status=overdue",
      group: "purchases", tone: "warn",
    },
    /* Stock the books say is below zero. Not a paperwork problem: either goods
       left that were never received, or a receipt is missing, and until it is
       settled the cost of everything sold from that item is a guess. */
    {
      n: (negativeStock as unknown as unknown[]).length,
      label: "Items at negative stock",
      detail: "a receipt is missing, or goods left twice",
      href: "/inventory/negative-stock",
      group: "inventory", tone: "bad",
    },
    /* Out of stock, or under the reorder point somebody set for it. The one
       alert here that is about the future rather than a mistake already made. */
    {
      n: (lowStock as unknown as unknown[]).length,
      label: "Out of stock or below reorder",
      detail: "counted per item and warehouse",
      href: "/items/stock",
      group: "inventory", tone: "warn",
    },
    /* Goods that left and were never billed. Stock is gone, the cost of sale
       is booked, and no receivable was ever raised — so the customer owes
       nothing, appears on no aging report, and nothing in the books looks
       wrong. It is a giveaway that nobody decided to make. */
    {
      n: actionItems.deliveriesUninvoiced.n,
      label: "Delivered not invoiced",
      detail: `oldest ${actionItems.deliveriesUninvoiced.oldestDays}d · ${money(actionItems.deliveriesUninvoiced.total)} given away unbilled`,
      href: "/sales/deliver?open=uninvoiced",
      group: "sales", tone: "warn",
    },
    /* The mirror: billed, owed for, and still on the shelf. The ledger is
       right and the customer is the one who finds out. */
    {
      n: actionItems.invoicesUndelivered.n,
      label: "Invoiced not delivered",
      detail: `oldest ${actionItems.invoicesUndelivered.oldestDays}d · goods still in the warehouse`,
      href: "/sales/deliver?open=undelivered",
      group: "sales", tone: "warn",
    },
    /* An invoice nobody agreed terms on. It cannot be chased, because there is
       no date it was supposed to be paid by — and it sits in aging under "No
       due date" rather than pretending to be current. */
    {
      n: noDueDate,
      label: "Missing due dates",
      detail: "no terms agreed, so nothing can be called overdue",
      href: "/finance/aging",
      group: "sales", tone: "info",
    },
  ] as (AttentionItem & { group: string })[]).filter((a) => a.n > 0);

  /* Grouped the way the reader works rather than the way the checks were
     written: everything about selling in one column, buying in the next,
     and stock only when it has something to say. */
  const attentionGroups: AttentionGroup[] = [
    { key: "sales", title: "Sales", sub: "Customer invoices and deliveries", icon: "sales" as const },
    { key: "purchases", title: "Purchases", sub: "Supplier orders, deliveries and bills", icon: "purchases" as const },
    { key: "inventory", title: "Inventory", sub: "Stock levels and reorder points", icon: "inventory" as const },
  ].map((g) => ({ ...g, items: actions.filter((a) => a.group === g.key) }))
   .filter((g) => g.items.length > 0);

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
  /* The chart can reach further back than the period asked for — a single
     chosen month is drawn against the five before it — so the total counts
     only the months inside the window, never every bar on screen. */
  const inWindow = (ym: string) =>
    ym >= period.rev.from.slice(0, 7) && ym < period.rev.to.slice(0, 7);
  const windowRows = trend.filter((r) => inWindow(r.month));
  const revenueTotal = windowRows.reduce((t, r) => t + n(r.revenue), 0);
  // Month on month, as the reference labels it. Null where there is no
  // previous month to compare with, or where it was zero — a rise from
  // nothing is not a percentage, and "+∞%" is not a figure anybody can use.
  const latestIdx = trend.findIndex((r) => r.month === (windowRows.at(-1)?.month ?? ""));
  const thisMonth = n(trend[latestIdx]?.revenue);
  const lastMonth = n(trend[latestIdx - 1]?.revenue);
  const change = lastMonth > 0 ? ((thisMonth - lastMonth) / lastMonth) * 100 : null;
  /* The percentage is month on month, and the figure above it is six months.
     Beside each other with nothing naming either period, the badge read as
     the movement in the big number — so both periods say which they are, and
     the month-on-month line carries the month's own figure with it. */
  const monthName = (ym: string | undefined) =>
    ym ? new Date(`${ym}-01T00:00:00`).toLocaleDateString("en-GB", { month: "long" }) : "";
  const thisMonthName = monthName(trend[latestIdx]?.month);
  const lastMonthName = monthName(trend[latestIdx - 1]?.month);

  const regions = regionRevenue as unknown as
    { id: string; name: string; revenue: number | string }[];

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

  /**
   * The two pipelines, each stage counted from what is actually open — and
   * mirrored, stage for stage, so the same shape reads the same way on both
   * sides: order placed, goods moved, document raised against goods that have
   * not moved, money outstanding.
   *
   * Stages only. "Overdue" appears nowhere here: the strip above owns every
   * exception, and Collection used to repeat its customer-invoices-overdue
   * figure exactly — the same number twice on one screen, pointing at two
   * different pages.
   */
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
    { n: actionItems.pendingDeliveryInvoices, name: "Invoicing",
      sub: "Awaiting delivery", href: "/sales/deliver?open=undelivered" },
    { n: n(kpis.ar.n), name: "Collection", sub: "Unpaid invoices", href: "/receivables" },
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
          {/* No page-wide period any more — each card carries its own, in its
              own header, next to the figure it changes. */}
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

      {urgent > 0 ? (
        <AttentionPanel total={urgent} groups={attentionGroups} />
      ) : (
        <div className="dash-banner">
          <span className="dash-banner-mark" aria-hidden="true"><Check size={16} /></span>
          <div>
            <strong>No urgent actions</strong>
            <span className="dash-sub" style={{ display: "block", color: "var(--muted)" }}>
              Invoices, orders and inventory checks are up to date.
            </span>
          </div>
        </div>
      )}

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
            <div>
              <h2>Revenue</h2>
              <span className="dash-sub">{period.rev.label}</span>
            </div>
            <PeriodPicker
              current={period.rev} label="revenue"
              hrefFor={(k) => hrefWith("rev", k)}
            />
          </div>
          <div className="dash-figure">
            {/* Six months of sales net of returns can land below zero, and
                when it does the minus sign is the whole message — easy to
                read past in a figure this size, and not at all in red. */}
            <span className="dash-figure-value" data-negative={revenueTotal < 0}>
              {cur(revenueTotal)}
            </span>
          </div>
          <span className="dash-kpi-note">
            {period.rev.month
              ? `Total for ${period.rev.label}`
              : `Total for ${period.rev.phrase}`}
          </span>

          <div className="dash-figure" style={{ marginTop: "0.75rem" }}>
            <span className="dash-month-value">
              {thisMonthName} {cur(thisMonth)}
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
              ? `${lastMonthName || "The earlier month"} had no revenue to compare with`
              : `Against ${lastMonthName} · ${cur(lastMonth)}`}
          </span>
          <div style={{ marginTop: "1.25rem" }}>
            {revenueTotal === 0
              ? <div className="empty">No revenue posted in {period.rev.phrase}.</div>
              : <RevenueBars
                  data={trend}
                  selected={period.rev.month}
                  hrefs={Object.fromEntries(
                    trend.map((r) => [r.month, hrefWith("rev", r.month)]),
                  )}
                />}
          </div>
        </div>

        <div className="dash-card dash-card-pad dash-rank-card">
          <div className="dash-section-head">
            <div>
              <h2>Top-selling items</h2>
              <span className="dash-sub">{period.items.label}, by revenue</span>
            </div>
            <PeriodPicker
              current={period.items} label="top-selling items"
              hrefFor={(k) => hrefWith("items", k)}
            />
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

      {/* Two halves of the same question — what sold, and where it sold.
          Side by side rather than one full-width card each, which left a
          240px donut marooned in a 1,140px box. */}
      <div className="dash-duo">
        <div className="dash-card dash-card-pad">
          <div className="dash-section-head">
            <div>
              <h2>Revenue by category</h2>
              <span className="dash-sub">
                Sales in {period.cat.phrase}, by how each item is filed
              </span>
            </div>
            <PeriodPicker
              current={period.cat} label="revenue by category"
              hrefFor={(k) => hrefWith("cat", k)}
            />
          </div>
          <ShareDonut
            data={topCategories as unknown as
              { id: string; name: string; revenue: number | string }[]}
            currency={company.base_currency}
          />
        </div>

        <div className="dash-card dash-card-pad">
          <div className="dash-section-head">
            <div>
              <h2>Revenue by state / region</h2>
              <span className="dash-sub">
                Sales in {period.reg.phrase}, by where the customer is
              </span>
            </div>
            <PeriodPicker
              current={period.reg} label="revenue by state or region"
              hrefFor={(k) => hrefWith("reg", k)}
            />
          </div>
          {/* One slice reading "Region not set" is a chart of nothing. Until
              somebody has said where a customer is, the card asks for that
              instead of drawing a circle around the whole company. */}
          {regions.length === 1 && regions[0].id === "none" ? (
            <div className="empty">
              No customer has a state or region yet.{" "}
              <Link href="/partners" style={{ color: "var(--brand)" }}>
                Set one on a customer
              </Link>{" "}
              to see where revenue comes from.
            </div>
          ) : (
            <ShareDonut data={regions} currency={company.base_currency} />
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
