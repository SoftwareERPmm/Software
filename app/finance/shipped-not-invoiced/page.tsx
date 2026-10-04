import Link from "next/link";
import { Truck, Clock, Boxes, AlertTriangle } from "lucide-react";
import { money, sql } from "@/lib/db";
import { DataTable, type DataRow } from "@/components/data-table";
import { HelpHint } from "@/components/help-hint";
import { AgingBands, SHIPPED_BANDS } from "@/components/aging-bands";
import {
  getCompany, getBranches, getShippedNotInvoiced,
  getShippedNotInvoicedBalance, UNASSIGNED_BRANCH,
} from "@/lib/queries";

const qty = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 4 });

/* Where the worry starts. Inside a week nothing is wrong — somebody is
   writing the invoice. After a month it is no longer a backlog, it is a
   sale nobody remembers making. */
const STALE_DAYS = 30;

export default async function ShippedNotInvoiced({
  searchParams,
}: {
  searchParams: Promise<{ branch?: string; band?: string }>;
}) {
  const p = await searchParams;
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const branches = (await getBranches(company.id)) as unknown as Array<{
    id: string; code: string; name: string;
  }>;
  const branchId =
    p.branch === UNASSIGNED_BRANCH ? UNASSIGNED_BRANCH
    : p.branch && branches.some((b) => b.id === p.branch) ? p.branch
    : null;

  /* The date the bands are measured against, read from the database rather
     than this server's clock — the ages were computed there, and a page
     printing its own idea of today could name a different one. */
  const [asOfRow] = await sql`select to_char(current_date, 'DD Mon YYYY') as d`;
  const asOf = String(asOfRow?.d ?? "");

  const [report, account] = await Promise.all([
    getShippedNotInvoiced(company.id, branchId),
    getShippedNotInvoicedBalance(company.id),
  ]);
  /* The account is only expected to agree with the report once cost of sales
     is recognised on the invoice. Until then it is empty by design, and the
     page says which of the two situations it is in rather than asserting the
     one that was true when it was written. */
  const held = account?.balance ?? 0;
  const gap = Math.round((held - report.total) * 10000) / 10000;

  const band = SHIPPED_BANDS.find((b) => b.bucket === p.band)?.bucket ?? null;
  const shown = band ? report.rows.filter((r) => r.bucket === band) : report.rows;

  const stale = report.rows.filter((r) => r.days > STALE_DAYS);
  const staleValue = stale.reduce((t, r) => t + r.value, 0);

  const bandBuckets = report.buckets.map((b) => ({
    aging_bucket: b.bucket, invoices: b.deliveries, total: String(b.value),
  }));

  const link = (over: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    const all = { branch: branchId ?? undefined, band: band ?? undefined, ...over };
    for (const [k, v] of Object.entries(all)) if (v) q.set(k, String(v));
    const s = q.toString();
    return `/finance/shipped-not-invoiced${s ? `?${s}` : ""}`;
  };

  const table: DataRow[] = shown.map((r) => ({
    key: r.deliveryId,
    searchText: `${r.docNo} ${r.partnerCode ?? ""} ${r.partnerName ?? ""}`.toLowerCase(),
    sort: {
      doc_no: r.docNo, date: r.postingDate, days: r.days,
      partner: (r.partnerName ?? "").toLowerCase(),
      items: r.items, qty: r.qty, value: r.value,
    },
    csv: {
      doc_no: r.docNo, posting_date: r.postingDate, days: r.days,
      partner_code: r.partnerCode ?? "", partner: r.partnerName ?? "",
      band: r.bucket, lines: r.items, qty: r.qty, cost_value: r.value,
    },
    node: (
      <tr>
        <td className="code">
          <Link href={`/documents/${r.deliveryId}`}>{r.docNo}</Link>
        </td>
        <td>{r.postingDate}</td>
        <td className="r">
          <span style={{ color: r.days > STALE_DAYS ? "var(--bad)" : undefined }}>
            {r.days}
          </span>
        </td>
        <td>
          <span className="agingdot"
                style={{ background: SHIPPED_BANDS.find((b) => b.bucket === r.bucket)?.band }}
                aria-hidden="true" />
          {r.bucket}
        </td>
        <td className="wrap">
          {r.partnerName ?? "—"}
          {r.partnerCode && <div className="subline">{r.partnerCode}</div>}
        </td>
        {/* Opened up rather than taken on trust: a figure somebody is about
            to invoice against should be checkable without leaving the page. */}
        <td className="r">
          <details className="drill">
            <summary>{r.items}</summary>
            <table className="drilltable">
              <tbody>
                {r.lines.map((l) => (
                  <tr key={l.itemCode}>
                    <td className="code">{l.itemCode}</td>
                    <td className="wrap">{l.itemName}</td>
                    <td className="r">{qty(l.qty)}</td>
                    <td className="r">{money(String(l.value))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </td>
        <td className="r">{qty(r.qty)}</td>
        <td className="r"><strong>{money(String(r.value))}</strong></td>
        <td className="r">
          <Link href={`/sales/new?delivery=${r.deliveryId}`}>Invoice</Link>
        </td>
      </tr>
    ),
  }));

  return (
    <div className="reportpage">
      <div className="page-head">
        <span className="eyebrow">Finance</span>
        <h1>Goods shipped not invoiced</h1>
        <HelpHint label="What this counts">
          Goods that have left the building with no sales invoice behind them,
          aged by how long ago they left. Valued at what the goods cost, not
          at what they would sell for, because that is the figure the books
          carry.
          <br /><br />
          A delivery and an invoice find each other four ways and all four are
          followed, so a sale billed on a separate document is not reported as
          unbilled. Deliveries are drawn down oldest first and each invoice
          takes its turn in posting order, so one delivery billed across two
          invoices is not counted twice.
          <br /><br />
          Free-of-charge lines and consignment lines are left out. Neither is
          waiting for an invoice: a giveaway was never going to be billed and
          its cost went to promotion expense, and consigned goods belong to
          somebody else.
          <br /><br />
          Ages are measured against {asOf}.
        </HelpHint>
      </div>

      <form className="row" style={{ margin: 0, alignItems: "flex-end" }}>
        {band && <input type="hidden" name="band" value={band} />}
        <div className="field">
          <label htmlFor="branch">Branch</label>
          <select id="branch" name="branch" defaultValue={branchId ?? ""}>
            <option value="">All branches</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.code} · {b.name}</option>
            ))}
          </select>
        </div>
        <div className="actions">
          <button type="submit">Update</button>
        </div>
      </form>

      <div className="kpis">
        <Tile icon={<Truck size={16} />} label="Shipped not invoiced"
              value={money(String(report.total))}
              sub={`${report.deliveries} ${report.deliveries === 1 ? "delivery" : "deliveries"}, at cost`} />
        <Tile icon={<Boxes size={16} />} label="Units out there"
              value={qty(report.qty)}
              sub="gone from stock, not yet billed" />
        <Tile icon={<AlertTriangle size={16} />} label={`Older than ${STALE_DAYS} days`}
              value={money(String(staleValue))}
              sub={stale.length === 0
                ? "nothing has been sitting"
                : `${stale.length} ${stale.length === 1 ? "delivery" : "deliveries"} to chase`} />
        <Tile icon={<Clock size={16} />} label="Oldest"
              value={report.oldestDays === 0 ? "—" : `${report.oldestDays} days`}
              sub={report.oldestDays === 0 ? "nothing outstanding" : "since the goods left"} />
      </div>

      <section className="grid2">
        <AgingBands
          title="By age"
          bands={SHIPPED_BANDS}
          buckets={bandBuckets}
          subtitle={<>as at {asOf}</>}
        />

        <div className="card">
          <div className="card-head">
            <h2>Why this matters</h2>
            <span className="page-sub">1090</span>
          </div>
          <div className="card-body">
            <p className="page-sub" style={{ margin: 0, lineHeight: 1.6 }}>
              Every row here is a sale that has happened physically and not
              financially: the stock is gone, the customer has the goods, and
              nobody has been asked to pay. The older a row is, the less
              likely anyone still remembers the arrangement.
            </p>
            {held === 0 ? (
              <p className="page-sub" style={{ marginBottom: 0, lineHeight: 1.6 }}>
                Cost of sales is recognised on the delivery today, so these
                goods are already expensed and <strong>1090 holds nothing</strong>.
                If cost moves to the invoice, this total becomes that
                account&rsquo;s balance — and a clearing balance nobody ages
                is a balance nobody clears.
              </p>
            ) : (
              <p className="page-sub" style={{ marginBottom: 0, lineHeight: 1.6 }}>
                1090 holds <strong style={{ color: "var(--ink)" }}>{money(String(held))}</strong>,
                and this report accounts for{" "}
                <strong style={{ color: "var(--ink)" }}>{money(String(report.total))}</strong>
                {gap === 0 ? (
                  <> — they agree.</>
                ) : (
                  <>, a difference of{" "}
                    <strong style={{ color: "var(--bad)" }}>{money(String(gap))}</strong>{" "}
                    that belongs to neither. Something relieved the account
                    without billing the goods, or billed goods it never held.
                  </>
                )}
              </p>
            )}
            <p className="page-sub" style={{ marginBottom: 0 }}>
              <Link href="/sales/deliver?open=uninvoiced">
                The deliveries screen
              </Link>{" "}
              lists the same goods flat and at selling price, next to the
              button that bills them.
            </p>
          </div>
        </div>
      </section>

      <section>
        <div className="card">
          <div className="card-head">
            <h2>{band ? `${SHIPPED_BANDS.find((b) => b.bucket === band)?.label}` : "Every unbilled delivery"}</h2>
            <span className="erp-tabs" style={{ border: 0 }}>
              <Link href={link({ band: undefined })}
                    className={`erp-tab ${band === null ? "here" : ""}`}>All</Link>
              {SHIPPED_BANDS.map((b) => (
                <Link key={b.key} href={link({ band: b.bucket })}
                      className={`erp-tab ${band === b.bucket ? "here" : ""}`}>
                  {b.label}
                </Link>
              ))}
            </span>
          </div>
          <DataTable
            rows={table}
            emptyLabel="Everything that has shipped has been invoiced."
            searchPlaceholder="Search deliveries…"
            defaultSort={{ key: "days", dir: "desc" }}
            defaultPageSize={25}
            columns={[
              { key: "doc_no", label: "Delivery", sortable: true },
              { key: "date", label: "Shipped", sortable: true },
              { key: "days", label: "Days", sortable: true, align: "r" },
              { key: "band", label: "Band" },
              { key: "partner", label: "Customer", sortable: true },
              { key: "items", label: "Lines", sortable: true, align: "r" },
              { key: "qty", label: "Qty", sortable: true, align: "r" },
              { key: "value", label: "Cost value", sortable: true, align: "r" },
              { key: "act", label: "" },
            ]}
          />
        </div>
      </section>
    </div>
  );
}

function Tile({ icon, label, value, sub }: {
  icon: React.ReactNode; label: string; value: string; sub: string;
}) {
  return (
    <div className="kpi">
      <div className="kpi-label">{icon}{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-note">{sub}</div>
    </div>
  );
}
