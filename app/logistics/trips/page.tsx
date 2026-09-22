import Link from "next/link";
import { money, shortDate } from "@/lib/format";
import { getCompany, getTrips } from "@/lib/queries";
import { DataTable, type DataRow } from "@/components/data-table";
import { HelpHint } from "@/components/help-hint";

const toTime = (v: unknown) => (v ? new Date(v as string).getTime() : 0);

const PILL: Record<string, string> = {
  PLANNED: "", DISPATCHED: "ok", CLOSED: "posted", CANCELLED: "warn",
};

export default async function Trips() {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const trips = (await getTrips(company.id)) as unknown as Array<{
    id: string; trip_no: string; trip_date: string; status: string;
    location_name: string | null; vehicle_code: string | null; plate_no: string | null;
    driver_name: string | null; salesman_name: string | null;
    stops: string; delivered: string; failed: string; pending: string;
    goods_value: string;
  }>;

  const rows: DataRow[] = trips.map((t) => ({
    key: t.id,
    searchText: [t.trip_no, t.driver_name, t.plate_no, t.salesman_name, t.location_name]
      .filter(Boolean).join(" "),
    sort: {
      trip_no: t.trip_no,
      trip_date: toTime(t.trip_date),
      driver_name: t.driver_name ?? "",
      plate_no: t.plate_no ?? "",
      stops: Number(t.stops),
      goods_value: Number(t.goods_value),
      status: t.status,
    },
    node: (
      <tr className="link">
        <td className="code">
          <Link href={`/logistics/trips/${t.id}`} style={{ color: "var(--brand)" }}>
            {t.trip_no}
          </Link>
        </td>
        <td className="code">{shortDate(t.trip_date)}</td>
        <td className="wrap">
          {t.driver_name ?? "—"}
          {t.salesman_name && <div className="subline">with {t.salesman_name}</div>}
        </td>
        <td className="code">{t.plate_no ?? "—"}</td>
        <td className="r">{t.stops}</td>
        <td>
          {/* Delivered / failed / still out, rather than one number. The
              evening question is which of the three a stop landed in. */}
          {Number(t.stops) === 0 ? "—" : (
            <span className="subline">
              {t.delivered} delivered
              {Number(t.failed) > 0 && <> · {t.failed} failed</>}
              {Number(t.pending) > 0 && <> · {t.pending} pending</>}
            </span>
          )}
        </td>
        <td className="r">{money(t.goods_value)}</td>
        <td><span className={`pill ${PILL[t.status] ?? ""}`}>{t.status.toLowerCase()}</span></td>
      </tr>
    ),
  }));

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Logistics</span>
        <h1>Delivery trips</h1>
        <HelpHint>
          One truck, one day, one ordered list of shops. A trip groups
          deliveries that are already posted — the stock left the warehouse
          when the delivery did — so marking a stop delivered is proof of
          delivery and never touches the ledger.
          <br /><br />
          A stop that fails is recorded as failed with the reason. The goods
          come back on the truck and the delivery still stands; a trip that
          can only say &ldquo;delivered&rdquo; forces somebody to lie.
        </HelpHint>
        <Link href="/logistics/trips/new" className="btn">New trip</Link>
      </div>

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Trips</h2>
            <span className="page-sub">{trips.length} trip{trips.length === 1 ? "" : "s"}</span>
          </div>
          <DataTable
            rows={rows}
            emptyLabel="No trips yet"
            searchPlaceholder="Search trips, drivers, plates…"
            defaultSort={{ key: "trip_date", dir: "desc" }}
            columns={[
              { key: "trip_no", label: "Trip #", sortable: true },
              { key: "trip_date", label: "Date", sortable: true },
              { key: "driver_name", label: "Driver", sortable: true },
              { key: "plate_no", label: "Vehicle", sortable: true },
              { key: "stops", label: "Stops", sortable: true, align: "r" },
              { key: "outcome", label: "Outcome" },
              { key: "goods_value", label: "Goods", sortable: true, align: "r" },
              { key: "status", label: "Status", sortable: true },
            ]}
          />
        </div>
      </section>
    </>
  );
}
