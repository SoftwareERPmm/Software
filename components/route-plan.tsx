"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { ActionResult } from "@/lib/actions";

const DAYS = [
  { n: 1, label: "Mon" }, { n: 2, label: "Tue" }, { n: 3, label: "Wed" },
  { n: 4, label: "Thu" }, { n: 5, label: "Fri" }, { n: 6, label: "Sat" },
  { n: 7, label: "Sun" },
];

type Stop = {
  id: string; seq: number; note: string | null;
  partner_id: string; partner_code: string; partner_name: string;
  township: string | null; region: string | null; phone: string | null;
  waiting: string;
};

type Candidate = {
  id: string; code: string; name: string;
  township: string | null; region: string | null;
};

type Run = { id: string; trip_no: string; trip_date: string; status: string };

const shortDate = (v: string) =>
  new Date(v).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/**
 * The standing call list, and the button that turns it into today's trip.
 *
 * Generating is deliberately a press rather than a schedule. A beat that
 * created trips overnight would be making records nobody asked for on days
 * nobody worked, and the first wrong one costs more trust than the
 * convenience is worth. So the plan sits here and somebody runs it.
 */
export function RoutePlan({
  route, stops, runs, candidates, today,
  vehicles, drivers, salesmen, branches,
  addAction, removeAction, reorderAction, generateAction,
  updateAction, setActiveAction,
}: {
  route: {
    id: string; code: string; name: string; weekdays: number[];
    location_name: string | null; salesman_name: string | null;
    driver_name: string | null; plate_no: string | null;
    location_id: string | null; salesman_id: string | null;
    driver_id: string | null; vehicle_id: string | null;
    note: string | null; last_run: string | null; is_active: boolean;
  };
  stops: Stop[];
  runs: Run[];
  candidates: Candidate[];
  today: string;
  vehicles: { id: string; code: string; plate_no: string }[];
  drivers: { id: string; name: string }[];
  salesmen: { id: string; name: string }[];
  branches: { id: string; code: string; name: string }[];
  addAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  removeAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  reorderAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  generateAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  updateAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  setActiveAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
}) {
  const [addState, addFormAction, adding] =
    useActionState<ActionResult | null, FormData>(addAction as never, null);
  const [removeState, removeFormAction] =
    useActionState<ActionResult | null, FormData>(removeAction as never, null);
  const [reorderState, reorderFormAction, reordering] =
    useActionState<ActionResult | null, FormData>(reorderAction as never, null);
  const [genState, genFormAction, generating] =
    useActionState<ActionResult | null, FormData>(generateAction as never, null);

  const [updateState, updateFormAction, saving] =
    useActionState<ActionResult | null, FormData>(updateAction as never, null);
  const [activeState, activeFormAction] =
    useActionState<ActionResult | null, FormData>(setActiveAction as never, null);

  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState(false);

  const router = useRouter();
  useEffect(() => {
    for (const st of [addState, removeState, reorderState, updateState, activeState]) {
      if (st && "ok" in st) { router.refresh(); return; }
    }
  }, [addState, removeState, reorderState, updateState, activeState, router]);

  useEffect(() => { if (updateState && "ok" in updateState) setEditing(false); }, [updateState]);

  const moved = (index: number, by: number) => {
    const next = [...stops];
    const [row] = next.splice(index, 1);
    next.splice(index + by, 0, row);
    return next;
  };

  const error = [addState, removeState, reorderState, genState, updateState, activeState]
    .find((s) => s && "error" in s) as { error: string } | undefined;

  const withGoods = stops.filter((s) => Number(s.waiting) > 0).length;
  const runsToday = route.weekdays.includes(
    // getDay() is 0-6 from Sunday; the column is ISO 1-7 from Monday.
    new Date(today).getDay() === 0 ? 7 : new Date(today).getDay(),
  );

  return (
    <>
      {error && <div className="alert">{error.error}</div>}

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Run this route</h2>
            <span className="page-sub">
              {route.last_run
                ? <>Last run {shortDate(route.last_run)}</>
                : <>Never run</>}
            </span>
          </div>
          <div className="card-body">
            <form action={genFormAction} className="form">
              <input type="hidden" name="route_id" value={route.id} />
              <div className="row">
                <div className="field">
                  <label htmlFor="trip_date">Day it runs</label>
                  <input id="trip_date" name="trip_date" type="date"
                         defaultValue={today} required />
                  {!runsToday && route.weekdays.length > 0 && (
                    <span className="hint">
                      This beat normally runs{" "}
                      {route.weekdays.map((d) => DAYS.find((x) => x.n === d)?.label).join(", ")}
                      {" "}— generating it anyway is fine.
                    </span>
                  )}
                </div>
              </div>
              <div className="actions">
                <button type="submit"
                        disabled={generating || stops.length === 0 || !route.is_active}>
                  {generating ? "Generating…" : "Generate trip"}
                </button>
                <span className="page-sub">
                  {stops.length === 0
                    ? "Add shops to the beat first."
                    : !route.is_active
                    ? "This route is retired."
                    : withGoods > 0
                    ? `${stops.length} stop${stops.length === 1 ? "" : "s"}, `
                      + `${withGoods} with goods already waiting`
                    : `${stops.length} call${stops.length === 1 ? "" : "s"}, no goods waiting yet`}
                </span>
              </div>
            </form>
          </div>
        </div>
      </section>

      {/* The standing arrangement, changeable. Created once and never
          editable would mean a beat that moved to Tuesdays, or a driver who
          left, could only be fixed by building the route again — and the old
          one's history would go with it. */}
      <section>
        <div className="card">
          <div className="card-head">
            <h2>The arrangement</h2>
            <span className="actions">
              <span className="page-sub">
                {route.weekdays.length > 0
                  ? route.weekdays.map((d) => DAYS.find((x) => x.n === d)?.label).join(", ")
                  : "no days set"}
                {route.driver_name && <> · {route.driver_name}</>}
                {route.plate_no && <> · {route.plate_no}</>}
                {route.salesman_name && <> · {route.salesman_name}</>}
              </span>
              <button type="button" className="btn ghost" onClick={() => setEditing((v) => !v)}>
                {editing ? "Cancel" : "Change"}
              </button>
              <form action={activeFormAction}>
                <input type="hidden" name="id" value={route.id} />
                <input type="hidden" name="active" value={route.is_active ? "0" : "1"} />
                <button type="submit" className="btn ghost">
                  {route.is_active ? "Retire route" : "Bring back"}
                </button>
              </form>
            </span>
          </div>

          {editing && (
            <div className="card-body">
              <form action={updateFormAction} className="form">
                <input type="hidden" name="id" value={route.id} />
                <div className="row">
                  <div className="field">
                    <label htmlFor="e-name">Name</label>
                    <input id="e-name" name="name" type="text"
                           defaultValue={route.name} required />
                  </div>
                  <div className="field">
                    <label htmlFor="e-location">Runs out of</label>
                    <select id="e-location" name="location_id"
                            defaultValue={route.location_id ?? ""}>
                      <option value="">Not set</option>
                      {branches.map((b) => (
                        <option key={b.id} value={b.id}>{b.code} · {b.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="e-salesman">Salesperson</label>
                    <select id="e-salesman" name="salesman_id"
                            defaultValue={route.salesman_id ?? ""}>
                      <option value="">Not set</option>
                      {salesmen.map((x) => (
                        <option key={x.id} value={x.id}>{x.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="e-driver">Driver</label>
                    <select id="e-driver" name="driver_id"
                            defaultValue={route.driver_id ?? ""}>
                      <option value="">Not set</option>
                      {drivers.map((x) => (
                        <option key={x.id} value={x.id}>{x.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="e-vehicle">Vehicle</label>
                    <select id="e-vehicle" name="vehicle_id"
                            defaultValue={route.vehicle_id ?? ""}>
                      <option value="">Not set</option>
                      {vehicles.map((v) => (
                        <option key={v.id} value={v.id}>{v.code} · {v.plate_no}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="field" style={{ marginTop: "0.75rem" }}>
                  <label>Days it runs</label>
                  <div className="row">
                    {DAYS.map((d) => (
                      <label className="check" key={d.n} htmlFor={`e-day-${d.n}`}>
                        <input id={`e-day-${d.n}`} name="weekday" type="checkbox"
                               value={d.n} defaultChecked={route.weekdays.includes(d.n)} />
                        {d.label}
                      </label>
                    ))}
                  </div>
                </div>

                <div className="field" style={{ marginTop: "0.75rem" }}>
                  <label htmlFor="e-note">Note</label>
                  <input id="e-note" name="note" type="text"
                         defaultValue={route.note ?? ""} />
                </div>

                <div className="actions">
                  <button type="submit" disabled={saving}>
                    {saving ? "Saving…" : "Save the arrangement"}
                  </button>
                  <span className="page-sub">
                    Changing this affects trips generated from now on. Runs
                    already made keep who actually went.
                  </span>
                </div>
              </form>
            </div>
          )}
        </div>
      </section>

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Shops on this beat</h2>
            <span className="actions">
              <span className="page-sub">{stops.length} stop{stops.length === 1 ? "" : "s"}</span>
              <button type="button" className="btn ghost" onClick={() => setShowAdd((v) => !v)}>
                {showAdd ? "Done adding" : "Add customers"}
              </button>
            </span>
          </div>

          {stops.length === 0 ? (
            <div className="empty">No shops on this beat yet.</div>
          ) : (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: "3rem" }}>#</th>
                    <th>Customer</th>
                    <th>Where</th>
                    <th>Waiting</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {stops.map((s, i) => (
                    <tr key={s.id}>
                      <td className="code">{s.seq}</td>
                      <td className="wrap">
                        <Link href={`/partners?role=customer`} style={{ color: "var(--brand)" }}>
                          {s.partner_name}
                        </Link>
                        <div className="subline">{s.partner_code}</div>
                      </td>
                      <td className="wrap">
                        {[s.township, s.region].filter(Boolean).join(", ") || "—"}
                        {s.phone && <div className="subline">{s.phone}</div>}
                      </td>
                      <td>
                        {/* Deliveries already posted for this shop and not on
                            a running trip — what generating would pick up. */}
                        {Number(s.waiting) > 0
                          ? <span className="pill ok">{s.waiting} to deliver</span>
                          : <span className="subline">call only</span>}
                      </td>
                      <td>
                        <div className="actions">
                          <form action={reorderFormAction}>
                            <input type="hidden" name="route_id" value={route.id} />
                            {moved(i, -1).map((r) => (
                              <input key={r.id} type="hidden" name="stop_id" value={r.id} />
                            ))}
                            <button type="submit" className="btn ghost"
                                    disabled={i === 0 || reordering}
                                    aria-label="Move earlier">↑</button>
                          </form>
                          <form action={reorderFormAction}>
                            <input type="hidden" name="route_id" value={route.id} />
                            {moved(i, 1).map((r) => (
                              <input key={r.id} type="hidden" name="stop_id" value={r.id} />
                            ))}
                            <button type="submit" className="btn ghost"
                                    disabled={i === stops.length - 1 || reordering}
                                    aria-label="Move later">↓</button>
                          </form>
                          <form action={removeFormAction}>
                            <input type="hidden" name="stop_id" value={s.id} />
                            <button type="submit" className="btn ghost">Remove</button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {showAdd && (
        <section>
          <div className="card">
            <div className="card-head">
              <h2>Customers not on this beat</h2>
              <span className="page-sub">{candidates.length} available</span>
            </div>
            {candidates.length === 0 ? (
              <div className="empty">Every active customer is already on this route.</div>
            ) : (
              <form action={addFormAction}>
                <input type="hidden" name="route_id" value={route.id} />
                <div className="tablewrap">
                  <table>
                    <thead>
                      <tr>
                        <th style={{ width: "3rem" }} />
                        <th>Code</th><th>Customer</th><th>Where</th>
                      </tr>
                    </thead>
                    <tbody>
                      {candidates.map((c) => (
                        <tr key={c.id}>
                          <td>
                            <input type="checkbox" name="partner_id" value={c.id}
                                   aria-label={`Add ${c.name}`} />
                          </td>
                          <td className="code">{c.code}</td>
                          <td className="wrap">{c.name}</td>
                          <td className="wrap">
                            {[c.township, c.region].filter(Boolean).join(", ") || "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="actions" style={{ padding: "0.75rem" }}>
                  <button type="submit" disabled={adding}>
                    {adding ? "Adding…" : "Add ticked customers"}
                  </button>
                </div>
              </form>
            )}
          </div>
        </section>
      )}

      {runs.length > 0 && (
        <section>
          <div className="card">
            <div className="card-head"><h2>Recent runs</h2></div>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr><th>Trip</th><th>Date</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id}>
                      <td className="code">
                        <Link href={`/logistics/trips/${r.id}`} style={{ color: "var(--brand)" }}>
                          {r.trip_no}
                        </Link>
                      </td>
                      <td className="code">{shortDate(r.trip_date)}</td>
                      <td><span className="pill">{r.status.toLowerCase()}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}
    </>
  );
}

export { DAYS };
