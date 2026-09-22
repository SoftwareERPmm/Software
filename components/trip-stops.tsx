"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { ActionResult } from "@/lib/actions";

const money = (v: string | number | null | undefined) =>
  Number(v ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 });

type Stop = {
  id: string; seq: number; status: string;
  delivered_at: string | null; failure_reason: string | null;
  /** Null on a stop generated from a route with nothing waiting: a call at
   *  a shop is a stop whether or not goods are going with it. */
  document_id: string | null; doc_no: string | null; gross_total: string;
  partner_name: string | null; township: string | null; region: string | null;
  phone: string | null; address: string | null;
};

type Candidate = {
  id: string; doc_no: string; doc_date: string; gross_total: string;
  partner_name: string | null; township: string | null; region: string | null;
};

/**
 * The running order, and what happened at each stop.
 *
 * Reordering is up/down rather than drag-and-drop. A route is built by
 * somebody who knows the town, usually on a phone, and a drag target that
 * has to be hit precisely while the list scrolls is the wrong control for
 * that. Two buttons are unambiguous and work with a thumb.
 *
 * The whole order is resubmitted on every move rather than a single swap,
 * because the server rewrites every seq inside one transaction — which is
 * what the deferred unique on (trip_id, seq) exists for.
 */
export function TripStops({
  tripId, tripStatus, stops, candidates,
  reorderAction, answerAction, removeAction, addAction,
}: {
  tripId: string;
  tripStatus: string;
  stops: Stop[];
  candidates: Candidate[];
  reorderAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  answerAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  removeAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  addAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
}) {
  const [reorderState, reorderFormAction, reordering] =
    useActionState<ActionResult | null, FormData>(reorderAction as never, null);
  const [answerState, answerFormAction] =
    useActionState<ActionResult | null, FormData>(answerAction as never, null);
  const [removeState, removeFormAction] =
    useActionState<ActionResult | null, FormData>(removeAction as never, null);
  const [addState, addFormAction, adding] =
    useActionState<ActionResult | null, FormData>(addAction as never, null);

  const [failing, setFailing] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  /* revalidatePath marks the server route stale but does not re-render a
     client component that stays on the page: reordering wrote the new
     sequence to the database and left the old one on screen. The refresh is
     what pulls the server component's answer back down. */
  const router = useRouter();
  useEffect(() => {
    for (const st of [reorderState, answerState, removeState, addState]) {
      if (st && "ok" in st) { router.refresh(); return; }
    }
  }, [reorderState, answerState, removeState, addState, router]);

  const open = tripStatus === "PLANNED" || tripStatus === "DISPATCHED";
  const planning = tripStatus === "PLANNED";

  /** The same list with one stop moved, submitted as the new order. */
  const moved = (index: number, by: number) => {
    const next = [...stops];
    const [row] = next.splice(index, 1);
    next.splice(index + by, 0, row);
    return next;
  };

  const error = [reorderState, answerState, removeState, addState]
    .find((s) => s && "error" in s) as { error: string } | undefined;

  return (
    <>
      {error && <div className="alert">{error.error}</div>}

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Stops</h2>
            <span className="actions">
              <span className="page-sub">
                {stops.length} stop{stops.length === 1 ? "" : "s"}
              </span>
              {open && (
                <button type="button" className="btn ghost"
                        onClick={() => setShowAdd((v) => !v)}>
                  {showAdd ? "Done adding" : "Add deliveries"}
                </button>
              )}
            </span>
          </div>

          {stops.length === 0 ? (
            <div className="empty">
              No stops yet — add the deliveries this truck is carrying.
            </div>
          ) : (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: "3rem" }}>#</th>
                    <th>Delivery</th>
                    <th>Customer</th>
                    <th>Where</th>
                    <th className="r">Value</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {stops.map((s, i) => (
                    <tr key={s.id}>
                      <td className="code">{s.seq}</td>
                      <td className="code">
                        {s.document_id ? (
                          <Link href={`/documents/${s.document_id}`}
                                style={{ color: "var(--brand)" }}>
                            {s.doc_no}
                          </Link>
                        ) : (
                          <span style={{ color: "var(--muted)" }}>call only</span>
                        )}
                      </td>
                      <td className="wrap">
                        {s.partner_name}
                        {s.phone && <div className="subline">{s.phone}</div>}
                      </td>
                      <td className="wrap">
                        {[s.township, s.region].filter(Boolean).join(", ") || "—"}
                        {s.address && <div className="subline">{s.address}</div>}
                      </td>
                      <td className="r">
                        {Number(s.gross_total) > 0 ? money(s.gross_total) : "—"}
                      </td>
                      <td>
                        {/* "Delivered" reads wrong on a call with no goods —
                            what happened there is that somebody turned up. */}
                        {s.status === "DELIVERED" && (
                          <span className="pill ok">
                            {s.document_id ? "delivered" : "visited"}
                          </span>
                        )}
                        {s.status === "FAILED" && (
                          <>
                            <span className="pill warn">failed</span>
                            {s.failure_reason && (
                              <div className="subline">{s.failure_reason}</div>
                            )}
                          </>
                        )}
                        {s.status === "PENDING" && <span className="pill">pending</span>}
                      </td>
                      <td>
                        <div className="actions">
                          {planning && (
                            <>
                              <form action={reorderFormAction}>
                                <input type="hidden" name="trip_id" value={tripId} />
                                {moved(i, -1).map((r) => (
                                  <input key={r.id} type="hidden" name="stop_id" value={r.id} />
                                ))}
                                <button type="submit" className="btn ghost"
                                        disabled={i === 0 || reordering}
                                        aria-label="Move earlier">↑</button>
                              </form>
                              <form action={reorderFormAction}>
                                <input type="hidden" name="trip_id" value={tripId} />
                                {moved(i, 1).map((r) => (
                                  <input key={r.id} type="hidden" name="stop_id" value={r.id} />
                                ))}
                                <button type="submit" className="btn ghost"
                                        disabled={i === stops.length - 1 || reordering}
                                        aria-label="Move later">↓</button>
                              </form>
                            </>
                          )}
                          {open && s.status === "PENDING" && (
                            <>
                              <form action={answerFormAction}>
                                <input type="hidden" name="stop_id" value={s.id} />
                                <input type="hidden" name="status" value="DELIVERED" />
                                <button type="submit" className="btn ghost">
                                  {s.document_id ? "Delivered" : "Visited"}
                                </button>
                              </form>
                              <button type="button" className="btn ghost"
                                      onClick={() => setFailing(failing === s.id ? null : s.id)}>
                                Failed
                              </button>
                            </>
                          )}
                          {planning && s.status === "PENDING" && (
                            <form action={removeFormAction}>
                              <input type="hidden" name="stop_id" value={s.id} />
                              <button type="submit" className="btn ghost">Remove</button>
                            </form>
                          )}
                          {/* A stop that already has an answer can be corrected
                              back to pending while the trip is still out — the
                              usual case is a tick on the wrong row. */}
                          {open && s.status !== "PENDING" && (
                            <form action={answerFormAction}>
                              <input type="hidden" name="stop_id" value={s.id} />
                              <input type="hidden" name="status" value="PENDING" />
                              <button type="submit" className="btn ghost">Undo</button>
                            </form>
                          )}
                        </div>

                        {failing === s.id && (
                          <form action={answerFormAction} className="form"
                                style={{ marginTop: "0.5rem" }}>
                            <input type="hidden" name="stop_id" value={s.id} />
                            <input type="hidden" name="status" value="FAILED" />
                            <div className="field">
                              <label htmlFor={`why-${s.id}`}>Why it failed</label>
                              <input id={`why-${s.id}`} name="failure_reason" type="text" required
                                     placeholder="Shop shut · money not ready · nobody there" />
                            </div>
                            <div className="actions">
                              <button type="submit">Record failure</button>
                              <button type="button" className="ghost"
                                      onClick={() => setFailing(null)}>Cancel</button>
                            </div>
                          </form>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {showAdd && open && (
        <section>
          <div className="card">
            <div className="card-head">
              <h2>Deliveries not on a running trip</h2>
              <span className="page-sub">{candidates.length} available</span>
            </div>
            {candidates.length === 0 ? (
              <div className="empty">
                Every posted delivery is already on a trip that is planned or out.
              </div>
            ) : (
              <form action={addFormAction}>
                <input type="hidden" name="trip_id" value={tripId} />
                <div className="tablewrap">
                  <table>
                    <thead>
                      <tr>
                        <th style={{ width: "3rem" }} />
                        <th>Delivery</th>
                        <th>Customer</th>
                        <th>Where</th>
                        <th className="r">Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {candidates.map((c) => (
                        <tr key={c.id}>
                          <td>
                            <input type="checkbox" name="document_id" value={c.id}
                                   aria-label={`Carry ${c.doc_no}`} />
                          </td>
                          <td className="code">{c.doc_no}</td>
                          <td className="wrap">{c.partner_name}</td>
                          <td className="wrap">
                            {[c.township, c.region].filter(Boolean).join(", ") || "—"}
                          </td>
                          <td className="r">{money(c.gross_total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="actions" style={{ padding: "0.75rem" }}>
                  <button type="submit" disabled={adding}>
                    {adding ? "Adding…" : "Add ticked deliveries"}
                  </button>
                </div>
              </form>
            )}
          </div>
        </section>
      )}
    </>
  );
}
