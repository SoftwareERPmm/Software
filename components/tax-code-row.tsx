"use client";

import { useActionState, useState } from "react";
import type { ActionResult } from "@/lib/actions";

type Rate = { rate: string | number; validFrom: string; documents: number };

type TaxCode = {
  id: string; code: string; name: string;
  is_active: boolean; documents: number;
  current: string | number | null;
  rates: Rate[];
};

const pct = (v: string | number | null) =>
  v === null ? "—" : `${Number(v)}%`;

/**
 * One tax code: its name, and the rates it has charged over time.
 *
 * The rate is not a field on this row. A rate that changed in September is
 * two facts — what it was until then and what it is after — and an invoice
 * raised in March is still a March invoice. So a change is added with the
 * date it starts from, and the old rate stays where it is, describing the
 * documents that were posted under it.
 */
export function TaxCodeRow({
  taxCode, updateAction, addRateAction, today,
}: {
  taxCode: TaxCode;
  updateAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  addRateAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  today: string;
}) {
  const [panel, setPanel] = useState<"none" | "edit" | "rate" | "history">("none");
  const [editState, editAction, editing] = useActionState<ActionResult | null, FormData>(
    updateAction as never, null,
  );
  const [rateState, rateAction, savingRate] = useActionState<ActionResult | null, FormData>(
    addRateAction as never, null,
  );

  const future = taxCode.rates.filter((r) => r.validFrom > today);

  return (
    <>
      <tr>
        <td className="code">{taxCode.code}</td>
        <td className="wrap">{taxCode.name}</td>
        <td className="r">
          {pct(taxCode.current)}
          {future.length > 0 && (
            <div className="subline">
              {pct(future[0].rate)} from {future[0].validFrom}
            </div>
          )}
        </td>
        <td>
          {Number(taxCode.current ?? 0) === 0 && taxCode.rates.length <= 1
            ? <span style={{ color: "var(--muted)" }}>Nothing posts</span>
            : "7000 / 1080"}
        </td>
        <td className="r">
          {taxCode.rates.length > 1 ? (
            <button type="button" className="linkish"
                    onClick={() => setPanel(panel === "history" ? "none" : "history")}>
              {taxCode.rates.length} rates
            </button>
          ) : (
            <span style={{ color: "var(--muted)" }}>1 rate</span>
          )}
        </td>
        <td className="r">{taxCode.documents || "—"}</td>
        <td>
          {taxCode.is_active
            ? <span className="pill ok">active</span>
            : <span className="pill warn">inactive</span>}
        </td>
        <td>
          <span className="actions">
            <button type="button" className="ghost tiny"
                    onClick={() => setPanel(panel === "rate" ? "none" : "rate")}>
              Change rate
            </button>
            <button type="button" className="ghost tiny"
                    onClick={() => setPanel(panel === "edit" ? "none" : "edit")}>
              Edit
            </button>
          </span>
        </td>
      </tr>

      {panel === "history" && (
        <tr>
          <td colSpan={8}>
            <div className="stockpanel">
              <h3>What {taxCode.code} has charged</h3>
              <table className="stockpanel-table">
                <thead>
                  <tr><th>From</th><th className="r">Rate</th><th className="r">Documents at this rate</th></tr>
                </thead>
                <tbody>
                  {[...taxCode.rates].reverse().map((r) => (
                    <tr key={r.validFrom}>
                      <td className="code">
                        {r.validFrom === "1900-01-01" ? "From the start" : r.validFrom}
                        {r.validFrom > today && <span className="pill warn"> scheduled</span>}
                      </td>
                      <td className="r">{pct(r.rate)}</td>
                      <td className="r">{r.documents || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      )}

      {panel === "rate" && (
        <tr>
          <td colSpan={8}>
            {rateState && "error" in rateState && <div className="alert">{rateState.error}</div>}
            <form action={rateAction} className="form">
              <input type="hidden" name="tax_code_id" value={taxCode.id} />
              <div className="row">
                <div className="field">
                  <label>New rate %</label>
                  <input name="rate" type="number" step="any" min="0" max="100" required
                         defaultValue={Number(taxCode.current ?? 0)} />
                </div>
                <div className="field">
                  <label>Charged from</label>
                  <input name="valid_from" type="date" defaultValue={today} required />
                  <span className="hint">
                    Invoices dated before this keep {pct(taxCode.current)}
                  </span>
                </div>
              </div>
              <div className="actions">
                <button type="submit" disabled={savingRate}>
                  {savingRate ? "Saving…" : "Schedule the change"}
                </button>
                <button type="button" className="ghost" onClick={() => setPanel("none")}>
                  Cancel
                </button>
              </div>
            </form>
          </td>
        </tr>
      )}

      {panel === "edit" && (
        <tr>
          <td colSpan={8}>
            {editState && "error" in editState && <div className="alert">{editState.error}</div>}
            <form action={editAction} className="form">
              <input type="hidden" name="id" value={taxCode.id} />
              <div className="row">
                <div className="field">
                  <label>Code</label>
                  <input name="code" defaultValue={taxCode.code} required />
                </div>
                <div className="field">
                  <label>Name</label>
                  <input name="name" defaultValue={taxCode.name} required />
                </div>
                <div className="field">
                  <label>
                    <input type="checkbox" name="is_active" defaultChecked={taxCode.is_active} />
                    {" "}Active
                  </label>
                  <span className="hint">Inactive codes stay on old documents</span>
                </div>
              </div>
              <div className="actions">
                <button type="submit" disabled={editing}>
                  {editing ? "Saving…" : "Save"}
                </button>
                <button type="button" className="ghost" onClick={() => setPanel("none")}>
                  Cancel
                </button>
              </div>
            </form>
          </td>
        </tr>
      )}
    </>
  );
}
