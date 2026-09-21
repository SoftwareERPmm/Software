import Link from "next/link";
import { Users, AlertTriangle, CreditCard, CalendarClock } from "lucide-react";
import { money } from "@/lib/db";
import { sql } from "@/lib/db";
import {
  getCompany, getAging, getDueWithin, getOpenItems, type AgingSide,
} from "@/lib/queries";
import { DataTable, type DataRow } from "@/components/data-table";
import { HelpHint } from "@/components/help-hint";
import { AgingBands, BUCKETS } from "@/components/aging-bands";
import { AgingRow, type AgingPartner } from "@/components/aging-row";

type Bucket = { aging_bucket: string; invoices: number; total: string };
type OpenItem = {
  document_id: string; doc_no: string; partner_id: string; partner_name: string;
  partner_code: string | null; posting_date: string | null; due_date: string | null;
  gross_total: string; outstanding: string; aging_bucket: string;
  days_overdue: number | null;
};

const n = (v: unknown) => Number(v ?? 0);

/**
 * A plain YYYY-MM-DD, whatever the driver handed over.
 *
 * v_open_item's date columns arrive as Date objects rather than strings —
 * getOpenItems selects them raw, unlike the queries that to_char them — and a
 * Date has no localeCompare, so sorting on one throws. Normalised once here
 * rather than changed in the shared query, which the receivables and payables
 * screens also read.
 */
const isoDay = (v: unknown): string | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 10);
};

export default async function AgingPage({
  searchParams,
}: {
  searchParams: Promise<{ side?: string }>;
}) {
  const { side } = await searchParams;
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const showAp = side === "ap";
  const docType: AgingSide = showAp ? "PURCHASE_INVOICE" : "SALES_INVOICE";

  /**
   * The date every band is measured against, read from the database rather
   * than from this server's clock.
   *
   * v_open_item buckets on CURRENT_DATE, so that is the only date the figures
   * were actually compared with — and a page that printed its own idea of
   * today could name a different one. It is stated because the arithmetic is
   * otherwise invisible: the table shows issued and due, and a reader asked to
   * believe "90+ days" has no third date on screen to check it against.
   */
  const [asOfRow] = await sql`select to_char(current_date, 'DD Mon YYYY') as d`;
  const asOf = String(asOfRow?.d ?? "");

  const [ar, ap, items, dueSoon] = await Promise.all([
    getAging(company.id, "SALES_INVOICE") as unknown as Promise<Bucket[]>,
    getAging(company.id, "PURCHASE_INVOICE") as unknown as Promise<Bucket[]>,
    getOpenItems(company.id, docType) as unknown as Promise<OpenItem[]>,
    getDueWithin(company.id, "PURCHASE_INVOICE"),
  ]);

  const sum = (b: Bucket[]) => b.reduce((t, x) => t + n(x.total), 0);
  // Overdue is a missed deadline. Neither the not-yet-due nor the
  // no-deadline-at-all band has missed one.
  const overdue = (b: Bucket[]) =>
    b.filter((x) => x.aging_bucket !== "CURRENT" && x.aging_bucket !== "NO_DUE_DATE")
     .reduce((t, x) => t + n(x.total), 0);

  const arTotal = sum(ar), apTotal = sum(ap);
  const arOverdue = overdue(ar);
  const partnerCount = (b: Bucket[]) => b.reduce((t, x) => t + x.invoices, 0);

  const pct = (part: number, whole: number) =>
    whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—";

  /**
   * One row per partner, with the invoices that make it up carried along.
   *
   * Grouped here rather than asked for per partner: the bills are already
   * loaded to produce the totals, so an opened row costs nothing and can
   * never show a figure that disagrees with the line above it.
   */
  const byPartner = new Map<string, AgingPartner>();
  for (const it of items) {
    let p = byPartner.get(it.partner_id);
    if (!p) {
      p = {
        partnerId: it.partner_id,
        partnerCode: it.partner_code ?? "",
        partnerName: it.partner_name,
        buckets: {}, total: 0, worstDays: null, invoices: [],
      };
      byPartner.set(it.partner_id, p);
    }
    const amount = n(it.outstanding);
    p.buckets[it.aging_bucket] = (p.buckets[it.aging_bucket] ?? 0) + amount;
    p.total += amount;
    if (it.days_overdue !== null && it.days_overdue > (p.worstDays ?? -1)) {
      p.worstDays = it.days_overdue;
    }
    p.invoices.push({
      documentId: it.document_id, docNo: it.doc_no,
      postingDate: isoDay(it.posting_date), dueDate: isoDay(it.due_date),
      grossTotal: n(it.gross_total), outstanding: amount,
      bucket: it.aging_bucket, daysOverdue: it.days_overdue,
    });
  }
  const partners = [...byPartner.values()].sort((a, b) => b.total - a.total);
  for (const p of partners) {
    // Oldest first inside a partner: the one to chase is at the top.
    p.invoices.sort((a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"));
  }

  // expander + partner + six bands + total + worst
  const AGING_COLUMNS = 3 + BUCKETS.length + 1;
  const backTo = `/finance/aging${showAp ? "?side=ap" : ""}`;

  const rows: DataRow[] = partners.map((p) => ({
    key: p.partnerId,
    searchText: [p.partnerCode, p.partnerName, ...p.invoices.map((i) => i.docNo)]
      .filter(Boolean).join(" "),
    sort: {
      partner: p.partnerName ?? "",
      ...Object.fromEntries(BUCKETS.map((b) => [b.key, p.buckets[b.bucket] ?? 0])),
      total: p.total,
      worst: p.worstDays ?? 0,
    },
    csv: {
      partner_code: p.partnerCode, partner: p.partnerName,
      ...Object.fromEntries(BUCKETS.map((b) => [b.key, p.buckets[b.bucket] ?? 0])),
      total: p.total, open_invoices: p.invoices.length,
    },
    node: <AgingRow partner={p} columnCount={AGING_COLUMNS} backTo={backTo} />,
  }));

  const tab = (isAp: boolean) => (
    <Link className="scopetab" data-active={showAp === isAp}
          href={`/finance/aging${isAp ? "?side=ap" : ""}`}>
      {isAp ? "Supplier aging" : "Customer aging"}
    </Link>
  );

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Accounting</span>
        <h1>AR / AP aging</h1>
        <span className="actions">
          <span className="asof">Measured as at {asOf}</span>
        </span>
        <HelpHint>
          What is owed, sorted by how late it is. A band counts the days from
          an invoice&rsquo;s due date to today — so a bill issued on the 5th and
          due on the 14th of April is 160 days late by the 21st of September,
          and the nine days it was given to pay are not what is being measured.
          A bill lands in a band by its own due date — nothing here is entered or stored, so an invoice moves
          between bands on its own as the date passes and leaves the moment it
          is paid. Current means not yet due, including bills with no due date
          agreed. The figures are the same ones Receivables and Payables show,
          read from the same open items, so the three screens cannot disagree.
        </HelpHint>
      </div>

      <div className="kpis kpis-tiled">
        <div className="kpi">
          <span className="kpi-icon" style={{
            color: "#3B6FD4", background: "color-mix(in srgb, #3B6FD4 12%, transparent)",
          }}><Users size={17} aria-hidden="true" /></span>
          <span className="kpi-body">
            <span className="kpi-label">Total receivables</span>
            <span className="kpi-value">{money(arTotal)}</span>
            <span className="kpi-note">
              {partnerCount(ar)} open invoice{partnerCount(ar) === 1 ? "" : "s"}
            </span>
          </span>
        </div>

        <div className="kpi">
          <span className="kpi-icon" style={{
            color: "var(--bad)", background: "color-mix(in srgb, var(--bad) 12%, transparent)",
          }}><AlertTriangle size={17} aria-hidden="true" /></span>
          <span className="kpi-body">
            <span className="kpi-label">Overdue receivables</span>
            <span className="kpi-value" style={{ color: arOverdue > 0 ? "var(--bad)" : undefined }}>
              {money(arOverdue)}
            </span>
            <span className="kpi-note">{pct(arOverdue, arTotal)} of total receivables</span>
          </span>
        </div>

        <div className="kpi">
          <span className="kpi-icon" style={{
            color: "var(--warn)", background: "color-mix(in srgb, var(--warn) 14%, transparent)",
          }}><CreditCard size={17} aria-hidden="true" /></span>
          <span className="kpi-body">
            <span className="kpi-label">Total payables</span>
            <span className="kpi-value">{money(apTotal)}</span>
            <span className="kpi-note">
              {partnerCount(ap)} open bill{partnerCount(ap) === 1 ? "" : "s"}
            </span>
          </span>
        </div>

        <div className="kpi">
          <span className="kpi-icon" style={{
            color: "#6C5CE0", background: "color-mix(in srgb, #6C5CE0 12%, transparent)",
          }}><CalendarClock size={17} aria-hidden="true" /></span>
          <span className="kpi-body">
            <span className="kpi-label">Due this week</span>
            <span className="kpi-value">{money(dueSoon.total)}</span>
            <span className="kpi-note">
              {dueSoon.invoices} supplier bill{dueSoon.invoices === 1 ? "" : "s"} within 7 days
            </span>
          </span>
        </div>
      </div>

      <div className="grid2">
        <AgingBands title="Accounts receivable" buckets={ar} />
        <AgingBands title="Accounts payable" buckets={ap} />
      </div>

      <section>
        <div className="card">
          <div className="card-head">
            <h2>{showAp ? "Supplier aging" : "Customer aging"}</h2>
            <span className="page-sub">
              {partners.length} {showAp ? "supplier" : "customer"}
              {partners.length === 1 ? "" : "s"} with a balance
            </span>
          </div>

          <div className="card-body" style={{ paddingBottom: 0 }}>
            <div className="scopetabs">{tab(false)}{tab(true)}</div>
          </div>

          {partners.length === 0 ? (
            <div className="empty">
              Nothing outstanding on this side. An invoice appears here while it
              is unpaid and leaves when it is settled.
            </div>
          ) : (
            <DataTable
              rows={rows}
              emptyLabel="Nothing outstanding"
              searchPlaceholder={showAp ? "Search suppliers…" : "Search customers…"}
              defaultSort={{ key: "total", dir: "desc" }}
              storageKey="aging"
              csvFilename={showAp ? "supplier-aging.csv" : "customer-aging.csv"}
              csvExtra={[
                { key: "partner_code", label: "Code" },
                { key: "open_invoices", label: "Open invoices" },
              ]}
              columns={[
                { key: "expand", label: "" },
                { key: "partner", label: showAp ? "Supplier" : "Customer", sortable: true },
                ...BUCKETS.map((b) => ({
                  key: b.key, label: b.label, sortable: true, align: "r" as const,
                })),
                { key: "total", label: "Total", sortable: true, align: "r" },
                { key: "worst", label: "Worst", sortable: true, align: "r" },
              ]}
              footerCells={{
                span: <>Total {showAp ? "payable" : "receivable"}</>,
                cells: {
                  ...Object.fromEntries(
                    BUCKETS.map((b) => [
                      b.key,
                      money(partners.reduce((t, p) => t + (p.buckets[b.bucket] ?? 0), 0)),
                    ])
                  ),
                  total: money(partners.reduce((t, p) => t + p.total, 0)),
                },
              }}
            />
          )}
        </div>
      </section>
    </>
  );
}
