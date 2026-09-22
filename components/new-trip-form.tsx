"use client";

import { useActionState, useState } from "react";
import type { ActionResult } from "@/lib/actions";

const money = (v: string | number | null | undefined) =>
  Number(v ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 });

type Candidate = {
  id: string; doc_no: string; doc_date: string; gross_total: string;
  partner_name: string | null; township: string | null; region: string | null;
  location_code: string | null;
};

/**
 * A truck, who is on it, and what it is carrying.
 *
 * The load is ticked here rather than on a second screen because a trip with
 * no stops is not a trip — it is a row somebody has to remember to come back
 * to. Stops can still be added later; this just refuses to make the empty
 * case the default one.
 */
export function NewTripForm({
  action, today, vehicles, drivers, salesmen, branches, candidates,
}: {
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  today: string;
  vehicles: { id: string; code: string; plate_no: string }[];
  drivers: { id: string; code: string; name: string }[];
  salesmen: { id: string; code: string; name: string }[];
  branches: { id: string; code: string; name: string }[];
  candidates: Candidate[];
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    action as never, null,
  );
  const [picked, setPicked] = useState<string[]>([]);

  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const chosen = candidates.filter((c) => picked.includes(c.id));
  const load = chosen.reduce((t, c) => t + Number(c.gross_total), 0);

  return (
    <form action={formAction} className="form wide">
      {state && "error" in state && <div className="alert">{state.error}</div>}

      {/* Ticked order is carried as the running order: the hidden inputs are
          emitted in the sequence the boxes were ticked, not the order the
          table happens to be sorted in. */}
      {picked.map((id) => (
        <input key={id} type="hidden" name="document_id" value={id} />
      ))}

      <div className="card doc-meta">
        <div className="card-body">
          <div className="row">
            <div className="field">
              <label htmlFor="trip_date">Trip date</label>
              <input id="trip_date" name="trip_date" type="date"
                     defaultValue={today} required />
            </div>
            <div className="field">
              <label htmlFor="location_id">Leaves from</label>
              <select id="location_id" name="location_id" defaultValue="">
                <option value="">Not set</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>{b.code} · {b.name}</option>
                ))}
              </select>
              <span className="hint">The branch, not the store within it</span>
            </div>
            <div className="field">
              <label htmlFor="vehicle_id">Vehicle</label>
              <select id="vehicle_id" name="vehicle_id" defaultValue="">
                <option value="">Not set</option>
                {vehicles.map((v) => (
                  <option key={v.id} value={v.id}>{v.code} · {v.plate_no}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="driver_id">Driver</label>
              <select id="driver_id" name="driver_id" defaultValue="">
                <option value="">Not set</option>
                {drivers.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="salesman_id">Salesperson</label>
              <select id="salesman_id" name="salesman_id" defaultValue="">
                <option value="">Nobody</option>
                {salesmen.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              <span className="hint">If one rides along</span>
            </div>
          </div>
          <div className="field" style={{ marginTop: "0.75rem" }}>
            <label htmlFor="note">Note</label>
            <input id="note" name="note" type="text"
                   placeholder="Anything the yard should know" />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>What it is carrying</h2>
          <span className="page-sub">
            {picked.length === 0
              ? `${candidates.length} deliveries not on a running trip`
              : `${picked.length} ticked · ${money(load)}`}
          </span>
        </div>

        {candidates.length === 0 ? (
          <div className="empty">
            No posted deliveries are free — every one is already on a trip that
            is planned or out.
          </div>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: "3rem" }} />
                  <th style={{ width: "3rem" }}>Order</th>
                  <th>Delivery</th>
                  <th>Customer</th>
                  <th>Where</th>
                  <th className="r">Value</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((c) => {
                  const at = picked.indexOf(c.id);
                  return (
                    <tr key={c.id}>
                      <td>
                        <input type="checkbox" checked={at >= 0}
                               onChange={() => toggle(c.id)}
                               aria-label={`Carry ${c.doc_no}`} />
                      </td>
                      <td className="code">{at >= 0 ? at + 1 : ""}</td>
                      <td className="code">{c.doc_no}</td>
                      <td className="wrap">{c.partner_name}</td>
                      <td className="wrap">
                        {[c.township, c.region].filter(Boolean).join(", ") || "—"}
                      </td>
                      <td className="r">{money(c.gross_total)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="actions">
        <button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create trip"}
        </button>
        <span className="page-sub">
          Nothing is posted. A trip records who carries goods that have already
          left the warehouse.
        </span>
      </div>
    </form>
  );
}
