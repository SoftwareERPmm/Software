"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { setTripStatus } from "@/lib/actions";
import type { ActionResult } from "@/lib/actions";

/**
 * Where the trip is in its journey, and the one move available from here.
 *
 * Deliberately not a row of four buttons. A trip goes planned → out → back,
 * and showing every state at once invites somebody to close a truck that has
 * not left. What is offered is what comes next.
 */
export function TripStatus({
  tripId, status, stops, pending, delivered, failed, departedAt, closedAt,
}: {
  tripId: string;
  status: string;
  stops: number;
  pending: number;
  delivered: number;
  failed: number;
  departedAt: string | null;
  closedAt: string | null;
}) {
  const [state, formAction, working] = useActionState<ActionResult | null, FormData>(
    setTripStatus as never, null,
  );

  // Same reason as the stop list: the page stays put, so the new status has
  // to be fetched rather than waited for.
  const router = useRouter();
  useEffect(() => {
    if (state && "ok" in state) router.refresh();
  }, [state, router]);

  const when = (v: string | null) =>
    v ? new Date(v).toLocaleString("en-GB", {
      day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
    }) : null;

  return (
    <section>
      {state && "error" in state && <div className="alert">{state.error}</div>}

      <div className="card">
        <div className="card-head">
          <h2>
            {status === "PLANNED" && "Being planned"}
            {status === "DISPATCHED" && "Out on the road"}
            {status === "CLOSED" && "Back and closed"}
            {status === "CANCELLED" && "Cancelled"}
          </h2>
          <span className="page-sub">
            {status === "CLOSED" || status === "DISPATCHED" ? (
              <>
                {delivered} of {stops} delivered
                {failed > 0 && <> · {failed} failed</>}
                {pending > 0 && <> · {pending} still to answer</>}
              </>
            ) : (
              <>{stops} stop{stops === 1 ? "" : "s"}</>
            )}
          </span>
        </div>

        <div className="card-body">
          <div className="actions">
            {status === "PLANNED" && (
              <>
                <form action={formAction}>
                  <input type="hidden" name="trip_id" value={tripId} />
                  <input type="hidden" name="status" value="DISPATCHED" />
                  <button type="submit" disabled={working || stops === 0}>
                    {working ? "…" : "Dispatch"}
                  </button>
                </form>
                <Link href={`/logistics/trips/${tripId}/print`} className="btn ghost">
                  Print manifest
                </Link>
                <form action={formAction}>
                  <input type="hidden" name="trip_id" value={tripId} />
                  <input type="hidden" name="status" value="CANCELLED" />
                  <button type="submit" className="ghost" disabled={working}>
                    Cancel trip
                  </button>
                </form>
                {stops === 0 && (
                  <span className="page-sub">A trip with no stops has nowhere to go.</span>
                )}
              </>
            )}

            {status === "DISPATCHED" && (
              <>
                <form action={formAction}>
                  <input type="hidden" name="trip_id" value={tripId} />
                  <input type="hidden" name="status" value="CLOSED" />
                  <button type="submit" disabled={working || pending > 0}>
                    {working ? "…" : "Close trip"}
                  </button>
                </form>
                <Link href={`/logistics/trips/${tripId}/print`} className="btn ghost">
                  Print manifest
                </Link>
                {pending > 0 && (
                  <span className="page-sub">
                    {pending} stop{pending === 1 ? "" : "s"} still unanswered — mark each
                    delivered or failed first.
                  </span>
                )}
              </>
            )}

            {(status === "CLOSED" || status === "CANCELLED") && (
              <>
                <Link href={`/logistics/trips/${tripId}/print`} className="btn ghost">
                  Print manifest
                </Link>
                <span className="page-sub">
                  {status === "CLOSED"
                    ? "This trip is a record of a journey that happened."
                    : "This trip never left."}
                </span>
              </>
            )}
          </div>

          {(departedAt || closedAt) && (
            <div className="subline" style={{ marginTop: "0.6rem" }}>
              {departedAt && <>Left {when(departedAt)}</>}
              {departedAt && closedAt && " · "}
              {closedAt && <>Back {when(closedAt)}</>}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
