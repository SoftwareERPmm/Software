import Link from "next/link";
import { notFound } from "next/navigation";
import { money, shortDate } from "@/lib/format";
import { getCompany, getTrip, getUncarriedDeliveries } from "@/lib/queries";
import { reorderTripStops, answerTripStop, removeTripStop, addTripStops } from "@/lib/actions";
import { TripStops } from "@/components/trip-stops";
import { TripStatus } from "@/components/trip-status";

export default async function TripDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const found = await getTrip(company.id, id);
  if (!found) notFound();
  const { trip, stops } = found as unknown as {
    trip: {
      id: string; trip_no: string; trip_date: string; status: string;
      location_name: string | null; vehicle_code: string | null; plate_no: string | null;
      driver_name: string | null; salesman_name: string | null; note: string | null;
      departed_at: string | null; closed_at: string | null;
      stops: string; delivered: string; failed: string; pending: string;
      goods_value: string;
    };
    stops: Parameters<typeof TripStops>[0]["stops"];
  };

  const candidates = (await getUncarriedDeliveries(company.id, trip.id)) as unknown as
    Parameters<typeof TripStops>[0]["candidates"];

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">
          <Link href="/logistics/trips" style={{ color: "inherit" }}>Delivery trips</Link>
        </span>
        <h1>{trip.trip_no}</h1>
        <span className="page-sub">
          {shortDate(trip.trip_date)}
          {trip.location_name && <> · from {trip.location_name}</>}
        </span>
      </div>

      <section>
        <div className="card">
          <div className="card-body">
            <div className="row">
              <div className="field">
                <label>Driver</label>
                <span className="fixedfield">{trip.driver_name ?? "—"}</span>
              </div>
              <div className="field">
                <label>Vehicle</label>
                <span className="fixedfield">{trip.plate_no ?? "—"}</span>
                {trip.vehicle_code && <span className="hint">{trip.vehicle_code}</span>}
              </div>
              <div className="field">
                <label>Salesperson</label>
                <span className="fixedfield">{trip.salesman_name ?? "—"}</span>
              </div>
              <div className="field">
                <label>Goods carried</label>
                <span className="fixedfield">{money(trip.goods_value)}</span>
                <span className="hint">
                  Value of the deliveries on board, already posted
                </span>
              </div>
            </div>
            {trip.note && (
              <div className="hintbar">{trip.note}</div>
            )}
          </div>
        </div>
      </section>

      <TripStatus
        tripId={trip.id}
        status={trip.status}
        stops={Number(trip.stops)}
        pending={Number(trip.pending)}
        delivered={Number(trip.delivered)}
        failed={Number(trip.failed)}
        departedAt={trip.departed_at}
        closedAt={trip.closed_at}
      />

      <TripStops
        tripId={trip.id}
        tripStatus={trip.status}
        stops={stops}
        candidates={candidates}
        reorderAction={reorderTripStops}
        answerAction={answerTripStop}
        removeAction={removeTripStop}
        addAction={addTripStops}
      />
    </>
  );
}
