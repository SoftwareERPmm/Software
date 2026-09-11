import Link from "next/link";
import { money, moneyOrTrace } from "@/lib/db";
import { getCompany, getPartnerBalances } from "@/lib/queries";
import { DataTable, type DataRow } from "@/components/data-table";

const TABS: Array<["" | "current" | "overdue" | "partial", string]> = [
  ["", "All"],
  ["current", "Current"],
  ["overdue", "Overdue"],
  ["partial", "Partially Paid"],
];

export default async function Receivables({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const all = (await getPartnerBalances(company.id, "SALES_INVOICE")) as any[];

  const rowState = (r: any) => {
    // A remnant below the currency's smallest unit is not a debt anybody can
    // settle, so it is not overdue — it would otherwise sit in this tab
    // showing "0" and reading as an empty list with a row in it.
    if (r.overdue_material) return "overdue";
    if (Number(r.paid) > 0 && Number(r.outstanding) > 0) return "partial";
    return "current";
  };

  const customers = status ? all.filter((r) => rowState(r) === status) : all;

  const totalReceivable = all.reduce((s, r) => s + Number(r.outstanding), 0);
  const totalOverdue = all.reduce((s, r) => s + Number(r.overdue ?? 0), 0);
  const totalDueSoon = all.reduce((s, r) => s + Number(r.due_soon ?? 0), 0);

  const rows: DataRow[] = customers.map((c) => ({
    key: c.partner_id,
    searchText: [c.partner_code, c.partner_name].filter(Boolean).join(" "),
    sort: {
      partner_name: c.partner_name ?? "",
      open_invoices: Number(c.open_invoices),
      outstanding: Number(c.outstanding),
      overdue: Number(c.overdue ?? 0),
      credit_limit: Number(c.credit_limit ?? 0),
    },
    node: (
      <tr className="link">
        <td className="wrap">
          <strong>{c.partner_name}</strong>
          <div className="m" style={{ color: "var(--muted)" }}>{c.partner_code}</div>
        </td>
        <td className="r">{c.open_invoices}</td>
        <td className="r">{moneyOrTrace(c.outstanding)}</td>
        <td className="r" style={{ color: Number(c.overdue) > 0 ? "var(--bad)" : undefined }}>
          {Number(c.overdue) !== 0 ? moneyOrTrace(c.overdue) : "—"}
        </td>
        <td className="r">{c.credit_limit != null ? money(c.credit_limit) : "—"}</td>
        <td className="tight">
          <Link href={`/sales/invoices?customer=${c.partner_id}`} className="btn ghost tiny">View</Link>
        </td>
      </tr>
    ),
  }));

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Sales</span>
        <h1>Receivables</h1>
        <span className="page-sub">
          What each customer owes, rolled up from their open invoices — not a
          balance kept on the customer, so it can never drift from the invoices
          behind it.
        </span>
      </div>

      <div className="kpis">
        <div className="kpi">
          <span className="kpi-label">Total Receivable</span>
          <span className="kpi-value">{moneyOrTrace(totalReceivable)}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Overdue</span>
          <span className="kpi-value" style={{ color: totalOverdue > 0 ? "var(--bad)" : undefined }}>
            {moneyOrTrace(totalOverdue)}
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Due Soon</span>
          <span className="kpi-value">{money(totalDueSoon)}</span>
          <span className="kpi-note">within 7 days</span>
        </div>
      </div>

      <div className="flow">
        {TABS.map(([value, label]) => (
          <Link
            key={value}
            href={value ? `/receivables?status=${value}` : "/receivables"}
            className={`flow-node ${(status ?? "") === value ? "here" : ""}`}
          >
            {label}
          </Link>
        ))}
      </div>

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Customers</h2>
            <span className="actions">
              <span className="page-sub">{customers.length} with a balance</span>
              <Link href="/receivables/receive" className="btn">Receive payment</Link>
            </span>
          </div>
          <DataTable
            rows={rows}
            emptyLabel="Nothing outstanding"
            searchPlaceholder="Search customers…"
            defaultSort={{ key: "outstanding", dir: "desc" }}
            columns={[
              { key: "partner_name", label: "Customer", sortable: true },
              { key: "open_invoices", label: "Invoices", sortable: true, align: "r" },
              { key: "outstanding", label: "Outstanding", sortable: true, align: "r" },
              { key: "overdue", label: "Overdue", sortable: true, align: "r" },
              { key: "credit_limit", label: "Credit Limit", sortable: true, align: "r" },
              { key: "actions", label: "" },
            ]}
            footer={
              <tr>
                <td colSpan={2}>Total outstanding</td>
                <td className="r">{moneyOrTrace(totalReceivable)}</td>
                <td className="r">{moneyOrTrace(totalOverdue)}</td>
                <td colSpan={2} />
              </tr>
            }
          />
        </div>
      </section>
    </>
  );
}
