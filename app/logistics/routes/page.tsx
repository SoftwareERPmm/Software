import Link from "next/link";
import { getCompany, getRoutes } from "@/lib/queries";
import { DataTable, type DataRow } from "@/components/data-table";
import { HelpHint } from "@/components/help-hint";

const DAYS = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const shortDate = (v: string | null) =>
  v ? new Date(v).toLocaleDateString("en-GB",
    { day: "numeric", month: "short", year: "numeric" }) : "never";

export default async function Routes() {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const routes = (await getRoutes(company.id)) as unknown as Array<{
    id: string; code: string; name: string; weekdays: number[];
    location_name: string | null; salesman_name: string | null;
    driver_name: string | null; plate_no: string | null;
    stops: string; last_run: string | null; is_active: boolean;
  }>;

  const rows: DataRow[] = routes.map((r) => ({
    key: r.id,
    searchText: [r.code, r.name, r.salesman_name, r.driver_name, r.location_name]
      .filter(Boolean).join(" "),
    sort: {
      code: r.code, name: r.name,
      days: (r.weekdays ?? []).join(","),
      stops: Number(r.stops),
      salesman_name: r.salesman_name ?? "",
      last_run: r.last_run ? new Date(r.last_run).getTime() : 0,
      is_active: r.is_active ? 1 : 0,
    },
    node: (
      <tr className="link">
        <td className="code">
          <Link href={`/logistics/routes/${r.id}`} style={{ color: "var(--brand)" }}>
            {r.code}
          </Link>
        </td>
        <td className="wrap">{r.name}</td>
        <td className="code">
          {(r.weekdays ?? []).length === 0
            ? "—"
            : r.weekdays.map((d) => DAYS[d]).join(" ")}
        </td>
        <td className="r">{r.stops}</td>
        <td className="wrap">
          {r.salesman_name ?? "—"}
          {r.driver_name && <div className="subline">{r.driver_name}</div>}
        </td>
        <td className="code">{shortDate(r.last_run)}</td>
        <td>
          {r.is_active
            ? <span className="pill ok">active</span>
            : <span className="pill warn">retired</span>}
        </td>
      </tr>
    ),
  }));

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Logistics</span>
        <h1>Routes</h1>
        <HelpHint>
          A beat: the same shops, in the same order, on the same days. It is a
          template, not a schedule — somebody presses generate on the morning
          of the run and gets a trip they can then change.
          <br /><br />
          Generating picks up any posted delivery already waiting for a shop on
          the beat. A shop with nothing waiting still gets a stop, because on a
          pre-sale round the call is the job.
        </HelpHint>
        <Link href="/logistics/routes/new" className="btn">New route</Link>
      </div>

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Beats</h2>
            <span className="page-sub">{routes.length} route{routes.length === 1 ? "" : "s"}</span>
          </div>
          <DataTable
            rows={rows}
            emptyLabel="No routes yet"
            searchPlaceholder="Search routes…"
            defaultSort={{ key: "code", dir: "asc" }}
            columns={[
              { key: "code", label: "Code", sortable: true },
              { key: "name", label: "Route", sortable: true },
              { key: "days", label: "Runs", sortable: true },
              { key: "stops", label: "Shops", sortable: true, align: "r" },
              { key: "salesman_name", label: "Normally", sortable: true },
              { key: "last_run", label: "Last run", sortable: true },
              { key: "is_active", label: "Status", sortable: true },
            ]}
          />
        </div>
      </section>
    </>
  );
}
