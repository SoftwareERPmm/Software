import Link from "next/link";
import { money, shortDate } from "@/lib/format";
import { getCompany, getDiscountsGiven, getDiscountsByPartner } from "@/lib/queries";
import { DataTable, type DataRow } from "@/components/data-table";
import { HelpHint } from "@/components/help-hint";

const toTime = (v: unknown) => (v ? new Date(v as string).getTime() : 0);
const pct = (v: string | number) => `${Number(v ?? 0).toFixed(1)}%`;

export default async function DiscountsGiven({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const sp = await searchParams;
  // Default to the last twelve months: a discount policy is judged over a
  // year, not a month, and one month of a quiet season reads as generosity.
  const today = new Date();
  const to = sp.to ?? new Date(today.getFullYear(), today.getMonth() + 1, 1)
    .toISOString().slice(0, 10);
  const from = sp.from ?? new Date(today.getFullYear() - 1, today.getMonth(), 1)
    .toISOString().slice(0, 10);

  const [lines, byPartner] = await Promise.all([
    getDiscountsGiven(company.id, from, to),
    getDiscountsByPartner(company.id, from, to),
  ]) as unknown as [
    Array<{
      document_line_id: string; document_id: string; doc_no: string;
      posting_date: string; partner_name: string | null;
      item_code: string | null; item_name: string | null;
      line_discount: string; volume_discount: string; invoice_discount: string;
      total_discount: string; net_amount: string; gross_before_discount: string;
    }>,
    Array<{
      partner_id: string; partner_name: string | null; invoices: number;
      line_discount: string; volume_discount: string; invoice_discount: string;
      total_discount: string; gross_before_discount: string; discount_pct: string;
    }>,
  ];

  const total = lines.reduce((t, l) => t + Number(l.total_discount), 0);
  const gross = lines.reduce((t, l) => t + Number(l.gross_before_discount), 0);

  const rows: DataRow[] = lines.map((l) => ({
    key: l.document_line_id,
    searchText: [l.doc_no, l.partner_name, l.item_code, l.item_name]
      .filter(Boolean).join(" "),
    sort: {
      posting_date: toTime(l.posting_date),
      doc_no: l.doc_no,
      partner_name: l.partner_name ?? "",
      item_code: l.item_code ?? "",
      total_discount: Number(l.total_discount),
      net_amount: Number(l.net_amount),
    },
    node: (
      <tr className="link">
        <td className="code">{shortDate(l.posting_date)}</td>
        <td className="code">
          <Link href={`/documents/${l.document_id}`} style={{ color: "var(--brand)" }}>
            {l.doc_no}
          </Link>
        </td>
        <td className="wrap">{l.partner_name}</td>
        <td className="wrap">
          {l.item_name}
          {l.item_code && <div className="subline">{l.item_code}</div>}
        </td>
        {/* Kept apart: a price agreed with one customer, a volume break
            earned by the order's size, and a discount spread across the
            whole invoice are different decisions by different people. */}
        <td className="r">{Number(l.line_discount) ? money(l.line_discount) : "—"}</td>
        <td className="r">{Number(l.volume_discount) ? money(l.volume_discount) : "—"}</td>
        <td className="r">{Number(l.invoice_discount) ? money(l.invoice_discount) : "—"}</td>
        <td className="r"><strong>{money(l.total_discount)}</strong></td>
        <td className="r">{money(l.net_amount)}</td>
      </tr>
    ),
  }));

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Sales</span>
        <h1>Discounts given</h1>
        <HelpHint>
          What was asked for and never collected. Sales post <strong>net</strong> —
          a line discounted 10% records revenue of 90, not 100 with a 10
          expense — so no account in the general ledger holds this figure, and
          it is read from the sales lines instead.
          <br /><br />
          That is the right treatment for a distributor: you did not spend
          money on a discount, you collected less. Keeping it out of the
          ledger and reporting it here answers the question without restating
          every sale.
        </HelpHint>
      </div>

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Given away</h2>
            <span className="page-sub">
              {shortDate(from)} to {shortDate(to)}
            </span>
          </div>
          <div className="card-body">
            <div className="row">
              <div className="field">
                <label>Total discount</label>
                <span className="fixedfield">{money(total)}</span>
              </div>
              <div className="field">
                <label>Of what was asked</label>
                <span className="fixedfield">
                  {gross > 0 ? pct((total / gross) * 100) : "—"}
                </span>
                <span className="hint">{money(gross)} at full price</span>
              </div>
              <div className="field">
                <label>Customers</label>
                <span className="fixedfield">{byPartner.length}</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {byPartner.length > 0 && (
        <section>
          <div className="card">
            <div className="card-head">
              <h2>By customer</h2>
              <span className="page-sub">worst first</span>
            </div>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th className="r">Invoices</th>
                    <th className="r">Discount</th>
                    <th className="r">At full price</th>
                    <th className="r">Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {byPartner.map((p) => (
                    <tr key={p.partner_id}>
                      <td className="wrap">{p.partner_name}</td>
                      <td className="r">{p.invoices}</td>
                      <td className="r">{money(p.total_discount)}</td>
                      <td className="r">{money(p.gross_before_discount)}</td>
                      <td className="r">{pct(p.discount_pct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Every discounted line</h2>
            <span className="page-sub">{lines.length} lines</span>
          </div>
          <DataTable
            rows={rows}
            emptyLabel="No discounts given in this period"
            searchPlaceholder="Search documents, customers, items…"
            defaultSort={{ key: "posting_date", dir: "desc" }}
            columns={[
              { key: "posting_date", label: "Date", sortable: true },
              { key: "doc_no", label: "Invoice", sortable: true },
              { key: "partner_name", label: "Customer", sortable: true },
              { key: "item_code", label: "Item", sortable: true },
              { key: "line", label: "Line", align: "r" },
              { key: "volume", label: "Volume", align: "r" },
              { key: "invoice", label: "Invoice-wide", align: "r" },
              { key: "total_discount", label: "Total", sortable: true, align: "r" },
              { key: "net_amount", label: "Charged", sortable: true, align: "r" },
            ]}
          />
        </div>
      </section>
    </>
  );
}
