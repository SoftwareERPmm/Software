"use client";

import { useActionState, useState } from "react";
import type { ActionResult } from "@/lib/actions";

type Location = { id: string; code: string; name: string; depth: number; is_stock_location: boolean };
type Kind = "office" | "warehouse";

export function AddLocationForm({
  action,
  locations,
}: {
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  locations: Location[];
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    action as never,
    null
  );
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>("warehouse");
  const [parentId, setParentId] = useState("");

  const offices = locations.filter((l) => !l.is_stock_location);

  if (!open) {
    return (
      <div className="actions">
        <button type="button" onClick={() => setOpen(true)}>+ Location</button>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>Add new Branch or Warehouse</h2>
        <span className="actions">
          <button type="button" className="ghost tiny" onClick={() => setOpen(false)}>Cancel</button>
        </span>
      </div>
      <div className="card-body">
        <form action={formAction} className="form">
          {state && "error" in state && <div className="alert">{state.error}</div>}
          <input type="hidden" name="is_stock_location" value={kind === "warehouse" ? "on" : ""} />
          <input type="hidden" name="parent_id" value={kind === "warehouse" ? parentId : ""} />

          <div className="field">
            <label>What is this?</label>
            <div className="row" style={{ gap: "1.5rem" }}>
              <label className="check">
                <input
                  type="radio" name="kind" value="warehouse" checked={kind === "warehouse"}
                  onChange={() => setKind("warehouse")}
                />
                Warehouse — holds stock, sits inside an office
              </label>
              <label className="check">
                <input
                  type="radio" name="kind" value="office" checked={kind === "office"}
                  onChange={() => setKind("office")}
                />
                Branch — a site that doesn&rsquo;t hold stock itself
              </label>
            </div>
          </div>

          <div className="row" style={{ marginTop: "0.5rem" }}>
            <div className="field">
              <label htmlFor="code">Code</label>
              <input id="code" name="code" type="text" required autoFocus
                placeholder={kind === "warehouse" ? "MAIN-WH" : "MDY"} />
            </div>
            <div className="field">
              <label htmlFor="name">Name</label>
              <input id="name" name="name" type="text" required
                placeholder={kind === "warehouse" ? "Main Warehouse" : "Mandalay Branch"} />
            </div>
            <div className="field">
              <label htmlFor="name_my">Name (Burmese)</label>
              <input id="name_my" name="name_my" type="text" />
            </div>

            {kind === "warehouse" && (
              <div className="field">
                <label htmlFor="parent_id_select">Branch</label>
                <select id="parent_id_select" value={parentId} onChange={(e) => setParentId(e.target.value)}>
                  <option value="">— none, stands on its own —</option>
                  {offices.map((l) => (
                    <option key={l.id} value={l.id}>{l.code} · {l.name}</option>
                  ))}
                </select>
                <span className="hint">
                  {offices.length === 0
                    ? "No branches yet — add one first so this warehouse belongs to it"
                    : "Which branch this warehouse belongs to. One branch can hold many warehouses."}
                </span>
              </div>
            )}
          </div>

          <div className="actions" style={{ marginTop: "0.75rem" }}>
            <button type="submit" disabled={pending}>
              {pending ? "Saving…" : kind === "warehouse" ? "Save warehouse" : "Save office"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
