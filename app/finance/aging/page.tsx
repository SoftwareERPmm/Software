import Link from "next/link";
import { Users, AlertTriangle, CreditCard, CalendarClock } from "lucide-react";
import { money } from "@/lib/db";
import {
  getCompany, getAging, getPartnerAging, getDueWithin, type AgingSide,
} from "@/lib/queries";
import { DataTable, type DataRow } from "@/components/data-table";
import { HelpHint } from "@/components/help-hint";
import { AgingBands, BUCKETS } from "@/components/aging-bands";

type Bucket = { aging_bucket: string; invoices: number; total: string };
type PartnerRow = {
  partner_id: string; partner_code: string; partner_name: string;
  open_invoices: number; total: string;
  current_amt: string | null; d1_30: string | null; d31_60: string | null;
  d61_90: string | null; d90: string | null;
  worst_days: number | null; latest_due: string | null;
};

const n = (v: unknown) => Number(v ?? 0);

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

  const [ar, ap, partners, dueSoon] = await Promise.all([
    getAging(company.id, "SALES_INVOICE") as unknown as Promise<Bucket[]>,
    getAging(company.id, "PURCHASE_INVOICE") as unknown as Promise<Bucket[]>,
    getPartnerAging(company.id, docType) as unknown as Promise<PartnerRow[]>,
    getDueWithin(company.id, "PURCHASE_INVOICE"),
  ]);

  const sum = (b: Bucket[]) => b.reduce((t, x) => t + n(x.total), 0);
  const overdue = (b: Bucket[]) =>
    b.filter((x) => x.aging_bucket !== "CURRENT").reduce((t, x) => t + n(x.total), 0);

  const arTotal = sum(ar), apTotal = sum(ap);
  const arOverdue = overdue(ar);
  const partnerCount = (b: Bucket[]) => b.reduce((t, x) => t + x.invoices, 0);

  const pct = (part: number, whole: number) =>
    whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—";

  const rows: DataRow[] = partners.map((p) => ({
    key: p.partner_id,
    searchText: [p.partner_code, p.partner_name].filter(Boolean).join(" "),
    sort: {
      partner: p.partner_name ?? "",
      current_amt: n(p.current_amt), d1_30: n(p.d1_30), d31_60: n(p.d31_60),
      d61_90: n(p.d61_90), d90: n(p.d90), total: n(p.total),
      worst: n(p.worst_days),
    },
    csv: {
      partner_code: p.partner_code, partner: p.partner_name,
      current_amt: n(p.current_amt), d1_30: n(p.d1_30), d31_60: n(p.d31_60),
      d61_90: n(p.d61_90), d90: n(p.d90), total: n(p.total),
      open_invoices: p.open_invoices, latest_due: p.latest_due ?? "",
    },
    node: (
      <tr>
        <td className="wrap">
          <strong>{p.partner_name}</strong>
          <div className="m" style={{ color: "var(--muted)" }}>{p.partner_code}</div>
        </td>
        {/* A blank cell rather than a zero: nothing is owed in that band, and
            a column of noughts reads as data somebody has to check. */}
        {(["current_amt", "d1_30", "d31_60", "d61_90", "d90"] as const).map((k, i) => (
          <td key={k} className="r"
              style={{ color: n(p[k]) > 0 && i > 0 ? BUCKETS[i].ink : undefined }}>
            {n(p[k]) > 0 ? money(n(p[k])) : "—"}
          </td>
        ))}
        <td className="r"><strong>{money(n(p.total))}</strong></td>
        <td className="r" style={{ color: "var(--muted)" }}>
          {p.worst_days && p.worst_days > 0 ? `${p.worst_days} d` : "—"}
        </td>
        <td className="r">
          <Link href={showAp ? `/payables` : `/receivables`}
                style={{ color: "var(--brand)" }}>Open</Link>
        </td>
      </tr>
    ),
  }));

  const tab = (isAp: boolean) => (
    <Link className="scopetab" data-active={showAp === isAp}
          href={`/finance/aging${isAp ? "?side=ap" : ""}`}>
      {isAp ? "Supplier aging" : "Customer aging"}
      <span className="scopetab-n">{isAp ? ap.length : ar.length}</span>
    </Link>
  );

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Accounting</span>
        <h1>AR / AP aging</h1>
        <HelpHint>
          What is owed, sorted by how late it is. A bill lands in a band by its
          own due date — nothing here is entered or stored, so an invoice moves
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
                { key: "latest_due", label: "Latest due date" },
              ]}
              columns={[
                { key: "partner", label: showAp ? "Supplier" : "Customer", sortable: true },
                ...BUCKETS.map((b) => ({
                  key: b.key, label: b.label, sortable: true, align: "r" as const,
                })),
                { key: "total", label: "Total", sortable: true, align: "r" },
                { key: "worst", label: "Worst", sortable: true, align: "r" },
                { key: "action", label: "" },
              ]}
              footerCells={{
                span: <>Total {showAp ? "payable" : "receivable"}</>,
                cells: {
                  ...Object.fromEntries(
                    BUCKETS.map((b) => [
                      b.key,
                      money(partners.reduce((t, p) => t + n(p[b.field as keyof PartnerRow]), 0)),
                    ])
                  ),
                  total: money(partners.reduce((t, p) => t + n(p.total), 0)),
                },
              }}
            />
          )}
        </div>
      </section>
    </>
  );
}
