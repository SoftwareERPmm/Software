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

export default async function Payables({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const all = (await getPartnerBalances(company.id, "PURCHASE_INVOICE")) as any[];

  const rowState = (r: any) => {
    // A remnant below the currency's smallest unit is not a debt anybody can
    // settle, so it is not overdue — it would otherwise sit in this tab
    // showing "0" and reading as an empty list with a row in it.
    if (r.overdue_material) return "overdue";
    if (Number(r.paid) > 0 && Number(r.outstanding) > 0) return "partial";
    return "current";
  };

  const suppliers = status ? all.filter((r) => rowState(r) === status) : all;

  const totalPayable = all.reduce((s, r) => s + Number(r.outstanding), 0);
  const totalOverdue = all.reduce((s, r) => s + Number(r.overdue ?? 0), 0);
  const totalDueSoon = all.reduce((s, r) => s + Number(r.due_soon ?? 0), 0);

  const rows: DataRow[] = suppliers.map((s) => ({
    key: s.partner_id,
    searchText: [s.partner_code, s.partner_name].filter(Boolean).join(" "),
    sort: {
      partner_name: s.partner_name ?? "",
      open_invoices: Number(s.open_invoices),
      outstanding: Number(s.outstanding),
      overdue: Number(s.overdue ?? 0),
    },
    node: (
      <tr className="link">
        <td className="wrap">
          <strong>{s.partner_name}</strong>
          <div className="m" style={{ color: "var(--muted)" }}>{s.partner_code}</div>
        </td>
        <td className="r">{s.open_invoices}</td>
        <td className="r">{money(s.outstanding)}</td>
        <td className="r" style={{ color: Number(s.overdue) > 0 ? "var(--bad)" : undefined }}>
          {Number(s.overdue) > 0 ? money(s.overdue) : "—"}
        </td>
        <td className="tight">
          <Link href={`/purchases/invoices?supplier=${s.partner_id}`} className="btn ghost tiny">View</Link>
        </td>
      </tr>
    ),
  }));

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Purchases</span>
        <h1>Payables</h1>
        <span className="page-sub">
          What you owe each supplier, rolled up from their open bills — not a
          balance kept on the supplier, so it can never drift from the invoices
          behind it.
        </span>
      </div>

      <div className="kpis">
        <div className="kpi">
          <span className="kpi-label">Total Payable</span>
          <span className="kpi-value">{moneyOrTrace(totalPayable)}</span>
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
            href={value ? `/payables?status=${value}` : "/payables"}
            className={`flow-node ${(status ?? "") === value ? "here" : ""}`}
          >
            {label}
          </Link>
        ))}
      </div>

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Suppliers</h2>
            <span className="actions">
              <span className="page-sub">{suppliers.length} with a balance</span>
              <Link href="/payables/pay" className="btn">Pay supplier</Link>
            </span>
          </div>
          <DataTable
            rows={rows}
            emptyLabel="Nothing outstanding"
            searchPlaceholder="Search suppliers…"
            defaultSort={{ key: "outstanding", dir: "desc" }}
            columns={[
              { key: "partner_name", label: "Supplier", sortable: true },
              { key: "open_invoices", label: "Invoices", sortable: true, align: "r" },
              { key: "outstanding", label: "Outstanding", sortable: true, align: "r" },
              { key: "overdue", label: "Overdue", sortable: true, align: "r" },
              { key: "actions", label: "" },
            ]}
            footer={
              <tr>
                <td colSpan={2}>Total outstanding</td>
                <td className="r">{moneyOrTrace(totalPayable)}</td>
                <td className="r">{moneyOrTrace(totalOverdue)}</td>
                <td />
              </tr>
            }
          />
        </div>
      </section>
    </>
  );
}
