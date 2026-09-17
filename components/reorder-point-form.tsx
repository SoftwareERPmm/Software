"use client";

import { useActionState, useState } from "react";
import type { ActionResult } from "@/lib/actions";

type Item = { id: string; code: string; name: string };
type Location = { id: string; code: string; name: string };

export function AddReorderPointForm({
  action,
  items,
  locations,
}: {
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  items: Item[];
  locations: Location[];
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    action as never,
    null
  );
  const [open, setOpen] = useState(false);

  const nothingToChooseFrom = items.length === 0 || locations.length === 0;

  if (!open) {
    return (
      <div className="actions">
        <button type="button" onClick={() => setOpen(true)} disabled={nothingToChooseFrom}>
          + Reorder point
        </button>
        {nothingToChooseFrom && (
          <span className="page-sub">Needs at least one stocked item and one warehouse.</span>
        )}
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>New reorder point</h2>
        <span className="actions">
          <button type="button" className="ghost tiny" onClick={() => setOpen(false)}>Cancel</button>
        </span>
      </div>
      <div className="card-body">
        <form action={formAction} className="form">
          {state && "error" in state && <div className="alert">{state.error}</div>}

          <div className="row">
            <div className="field">
              <label htmlFor="item_id">Item</label>
              <select id="item_id" name="item_id" required autoFocus>
                {items.map((i) => (
                  <option key={i.id} value={i.id}>{i.code} · {i.name}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="location_id">Warehouse</label>
              <select id="location_id" name="location_id" required>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>{l.code} · {l.name}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="min_qty">Reorder point</label>
              <input id="min_qty" name="min_qty" type="number" min="0" step="any" required placeholder="50" />
              <span className="hint">Flag this item at this warehouse once on hand drops below this.</span>
            </div>
          </div>

          <div className="actions" style={{ marginTop: "0.75rem" }}>
            <button type="submit" disabled={pending}>{pending ? "Saving…" : "Save reorder point"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
