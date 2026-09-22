import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getCompany, getTrip } from "@/lib/queries";
import { PrintButton } from "@/components/print-button";

/**
 * The sheet the driver takes with them.
 *
 * Not the printable-document layout every other type shares: that paper is
 * organised around a partner and a total, and this one is organised around a
 * sequence of shops. What matters here is the order, who to ask for, the
 * phone number when the shop is shut, and a box to sign per stop — a column
 * no other document has, because no other document is carried around all
 * day and written on.
 *
 * Values are printed per stop because the driver is handing over goods
 * somebody has to agree the worth of, and a total at the foot so the yard
 * can check what went out against what came back.
 */
const shortDate = (v: unknown) =>
  v ? new Date(String(v)).toLocaleDateString("en-GB",
    { day: "2-digit", month: "short", year: "numeric" }) : "";

const money = (v: string | number | null | undefined) =>
  Number(v ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 });

export default async function TripManifest({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const company = await getCompany();
  if (!company) notFound();

  const found = await getTrip(company.id, id);
  if (!found) notFound();

  const { trip, stops } = found as unknown as {
    trip: {
      id: string; trip_no: string; trip_date: string; status: string;
      location_name: string | null; plate_no: string | null;
      driver_name: string | null; salesman_name: string | null;
      note: string | null; goods_value: string;
    };
    stops: Array<{
      id: string; seq: number; status: string;
      document_id: string | null; doc_no: string | null; gross_total: string;
      partner_name: string | null; township: string | null; region: string | null;
      phone: string | null; address: string | null;
    }>;
  };

  return (
    <>
      <div className="actions noprint" style={{ marginBottom: "0.5rem" }}>
        <Link href={`/logistics/trips/${id}`} className="btn ghost tiny">
          <ArrowLeft size={13} aria-hidden="true" /> Back to the trip
        </Link>
        <PrintButton />
      </div>

      <div className="sheetwrap">
        <div className="sheet">
          <div className="sheet-head">
            <div>
              <div className="sheet-co">{company.name}</div>
              {company.name_my && <div className="sheet-co-my">{company.name_my}</div>}
            </div>
            <div style={{ textAlign: "right" }}>
              <div className="sheet-title">Delivery trip sheet</div>
              <div className="sheet-no">{trip.trip_no}</div>
              <div className="sheet-status">{trip.status.toLowerCase()}</div>
            </div>
          </div>

          {/* dl/dt/dd, which is what .sheet-meta lays out — divs and spans
              render the label hard against the value. */}
          <section className="sheet-meta">
            <dl>
              <dt>Date</dt>
              <dd><strong>{shortDate(trip.trip_date)}</strong></dd>
              <dt>Leaves from</dt>
              <dd>{trip.location_name ?? "—"}</dd>
            </dl>
            <dl>
              <dt>Driver</dt>
              <dd><strong>{trip.driver_name ?? "—"}</strong></dd>
              <dt>Vehicle</dt>
              <dd>{trip.plate_no ?? "—"}</dd>
            </dl>
            <dl>
              <dt>Salesperson</dt>
              <dd>{trip.salesman_name ?? "—"}</dd>
              <dt>Stops</dt>
              <dd><strong>{stops.length}</strong></dd>
            </dl>
          </section>

          <table className="sheet-table">
            <thead>
              <tr>
                <th style={{ width: "8mm" }}>#</th>
                <th>Customer</th>
                <th>Where</th>
                <th>Delivery</th>
                <th style={{ textAlign: "right" }}>Value</th>
                <th style={{ width: "32mm" }}>Received by</th>
              </tr>
            </thead>
            <tbody>
              {stops.map((s) => (
                <tr key={s.id}>
                  <td>{s.seq}</td>
                  <td>
                    <strong>{s.partner_name}</strong>
                    {s.phone && <div className="sheet-code">{s.phone}</div>}
                  </td>
                  <td>
                    {[s.township, s.region].filter(Boolean).join(", ") || "—"}
                    {s.address && <div className="sheet-code">{s.address}</div>}
                  </td>
                  {/* A call with no goods still prints: the driver is going
                      there, and on a pre-sale round that call is the job. */}
                  <td className="sheet-code">{s.doc_no ?? "call only"}</td>
                  <td style={{ textAlign: "right" }}>
                    {Number(s.gross_total) > 0 ? money(s.gross_total) : "—"}
                  </td>
                  {/* Left empty on purpose. The shop signs this column, and a
                      status printed here would be yesterday's answer to a
                      question being asked today. */}
                  <td />
                </tr>
              ))}
            </tbody>
          </table>

          {/* A table: .sheet-totals is styled as one, with th for the label
              and td for the figure. */}
          <table className="sheet-totals">
            <tbody>
              <tr className="strong">
                <th>Goods carried</th>
                <td>
                  {money(trip.goods_value)}{" "}
                  <span className="sheet-ccy">{company.base_currency}</span>
                </td>
              </tr>
            </tbody>
          </table>

          {trip.note && (
            <div className="sheet-memo">
              <div className="sheet-memo-label">Note</div>
              {trip.note}
            </div>
          )}

          <div className="sheet-sign">
            <div><div className="sheet-rule" />Loaded by</div>
            <div><div className="sheet-rule" />Driver</div>
            <div><div className="sheet-rule" />Checked back in by</div>
          </div>
        </div>
      </div>
    </>
  );
}
