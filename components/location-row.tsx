"use client";

import { useActionState, useState } from "react";
import type { ActionResult } from "@/lib/actions";

type Location = {
  id: string; code: string; name: string; name_my: string | null;
  parent_id: string | null; parent_name: string | null;
  is_stock_location: boolean; is_active: boolean;
};
type LocationNode = Location & { depth: number };
type Kind = "office" | "warehouse";

// Regular spaces collapse in HTML — a non-breaking space is what actually
// survives to indent a name, in every browser.
const NBSP = " ";

export function LocationRow({
  location,
  depth,
  locations,
  updateAction,
  deleteAction,
  deactivateAction,
}: {
  location: Location;
  /** How deep this row sits — 0 for a top-level office, 1 for a warehouse inside it, and so on. */
  depth: number;
  /** Every location in tree order, for the Office picker — includes this row, filtered out below. */
  locations: LocationNode[];
  updateAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  deleteAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  deactivateAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
}) {
  const [editing, setEditing] = useState(false);
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    updateAction as never,
    null
  );
  const [, deactFormAction] = useActionState<ActionResult | null, FormData>(
    deactivateAction as never,
    null
  );
  const [delState, delFormAction, delPending] = useActionState<ActionResult | null, FormData>(
    deleteAction as never,
    null
  );

  const [kind, setKind] = useState<Kind>(location.is_stock_location ? "warehouse" : "office");
  const [parentId, setParentId] = useState(location.parent_id ?? "");
  const offices = locations.filter((l) => !l.is_stock_location && l.id !== location.id);

  function confirmDelete(e: React.FormEvent<HTMLFormElement>) {
    if (!confirm(`Delete ${location.name}? This can't be undone.`)) e.preventDefault();
  }

  if (editing) {
    return (
      <tr>
        <td colSpan={4}>
          <form action={formAction} className="form" style={{ padding: "0.5rem 0" }}>
            {state && "error" in state && <div className="alert">{state.error}</div>}
            <input type="hidden" name="id" value={location.id} />
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
                  Warehouse
                </label>
                <label className="check">
                  <input
                    type="radio" name="kind" value="office" checked={kind === "office"}
                    onChange={() => setKind("office")}
                  />
                  Office
                </label>
              </div>
            </div>

            <div className="row" style={{ marginTop: "0.4rem" }}>
              <div className="field">
                <label>Code</label>
                <input name="code" type="text" defaultValue={location.code} required />
              </div>
              <div className="field">
                <label>Name</label>
                <input name="name" type="text" defaultValue={location.name} required />
              </div>
              <div className="field">
                <label>Name (Burmese)</label>
                <input name="name_my" type="text" defaultValue={location.name_my ?? ""} />
              </div>
              {kind === "warehouse" && (
                <div className="field">
                  <label>Office</label>
                  <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
                    <option value="">— none, stands on its own —</option>
                    {offices.map((l) => (
                      <option key={l.id} value={l.id}>{l.code} · {l.name}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <label className="check" style={{ marginTop: "0.4rem" }}>
              <input name="is_active" type="checkbox" defaultChecked={location.is_active} />
              Active
            </label>
            <div className="actions" style={{ marginTop: "0.5rem" }}>
              <button type="submit" disabled={pending}>{pending ? "Saving…" : "Save"}</button>
              <button type="button" className="ghost tiny" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </form>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td className="code">{location.code}</td>
      <td className="wrap">
        {depth > 0 && <span style={{ color: "var(--ghost)" }}>{NBSP.repeat(depth * 2)}└ </span>}
        {location.name}
        {location.name_my && (
          <div className="subline" style={{ marginLeft: depth > 0 ? "1.2rem" : 0 }}>
            {location.name_my}
          </div>
        )}
        {" "}
        {location.is_stock_location
          ? <span className="pill ok">warehouse</span>
          : <span className="pill">office</span>}
      </td>
      <td>{location.is_active ? <span className="pill ok">active</span> : <span className="pill warn">inactive</span>}</td>
      <td>
        <span className="actions">
          <button type="button" className="ghost tiny" onClick={() => setEditing(true)}>Edit</button>
          {location.is_active && (
            <form action={deactFormAction} style={{ display: "inline" }}>
              <input type="hidden" name="id" value={location.id} />
              <button type="submit" className="ghost tiny">Deactivate</button>
            </form>
          )}
          <form action={delFormAction} onSubmit={confirmDelete} style={{ display: "inline" }}>
            <input type="hidden" name="id" value={location.id} />
            <button type="submit" className="ghost tiny" disabled={delPending}>
              {delPending ? "Deleting…" : "Delete"}
            </button>
          </form>
        </span>
        {delState && "error" in delState && (
          <div className="hint" style={{ color: "var(--bad)" }}>{delState.error}</div>
        )}
      </td>
    </tr>
  );
}
