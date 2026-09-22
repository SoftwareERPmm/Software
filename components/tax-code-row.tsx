"use client";

import { useActionState, useState } from "react";
import type { ActionResult } from "@/lib/actions";

type TaxCode = {
  id: string; code: string; name: string; rate: string | number;
  is_active: boolean; documents: number;
};

/**
 * One tax code, editable in place.
 *
 * The rate is the only figure here that changes what the next invoice
 * charges, and nothing it does reaches backwards: the tax on a posted line
 * is stored on that line, so a rate that changes in April does not restate
 * what a customer paid in March. The count of documents already posted
 * against a code is shown for exactly that reason — it is history, not a
 * total that will move.
 */
export function TaxCodeRow({
  taxCode, updateAction,
}: {
  taxCode: TaxCode;
  updateAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
}) {
  const [editing, setEditing] = useState(false);
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    updateAction as never, null,
  );
  const rate = Number(taxCode.rate);

  if (editing) {
    return (
      <tr>
        <td colSpan={6}>
          {state && "error" in state && <div className="alert">{state.error}</div>}
          <form action={formAction} className="form">
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
                <label>Rate %</label>
                <input name="rate" type="number" step="any" min="0" max="100"
                       defaultValue={rate} required />
                <span className="hint">Applies to invoices raised from now on</span>
              </div>
              <div className="field">
                <label>
                  <input type="checkbox" name="is_active" defaultChecked={taxCode.is_active} />
                  {" "}Active
                </label>
              </div>
            </div>
            <div className="actions">
              <button type="submit" disabled={pending}>
                {pending ? "Saving…" : "Save"}
              </button>
              <button type="button" className="ghost" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </form>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td className="code">{taxCode.code}</td>
      <td className="wrap">{taxCode.name}</td>
      <td className="r">{rate === 0 ? "—" : `${rate}%`}</td>
      <td>
        {rate === 0
          ? <span style={{ color: "var(--muted)" }}>Nothing posts</span>
          : "7000 / 1080"}
      </td>
      <td className="r">{taxCode.documents || "—"}</td>
      <td>
        {taxCode.is_active
          ? <span className="pill ok">active</span>
          : <span className="pill warn">inactive</span>}
      </td>
      <td>
        <span className="actions">
          <button type="button" className="ghost tiny" onClick={() => setEditing(true)}>
            Edit
          </button>
        </span>
      </td>
    </tr>
  );
}
