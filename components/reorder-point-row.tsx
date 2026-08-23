"use client";

import { useActionState, useState } from "react";
import type { ActionResult } from "@/lib/actions";

type ReorderPoint = {
  id: string; item_code: string; item_name: string; location_code: string; min_qty: string | number;
};

export function ReorderPointRow({
  point,
  updateAction,
  deleteAction,
}: {
  point: ReorderPoint;
  updateAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  deleteAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
}) {
  const [editing, setEditing] = useState(false);
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    updateAction as never,
    null
  );
  const [delState, delFormAction, delPending] = useActionState<ActionResult | null, FormData>(
    deleteAction as never,
    null
  );

  function confirmDelete(e: React.FormEvent<HTMLFormElement>) {
    if (!confirm(`Remove the reorder point for ${point.item_name} at ${point.location_code}?`)) e.preventDefault();
  }

  if (editing) {
    return (
      <tr>
        <td className="code">{point.item_code}</td>
        <td className="wrap">{point.item_name}</td>
        <td className="code">{point.location_code}</td>
        <td colSpan={2}>
          <form action={formAction} style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            {state && "error" in state && (
              <span className="hint" style={{ color: "var(--bad)" }}>{state.error}</span>
            )}
            <input type="hidden" name="id" value={point.id} />
            <input
              name="min_qty" type="number" min="0" step="any" required autoFocus
              defaultValue={point.min_qty} style={{ width: "7rem" }}
            />
            <button type="submit" className="ghost tiny" disabled={pending}>{pending ? "Saving…" : "Save"}</button>
            <button type="button" className="ghost tiny" onClick={() => setEditing(false)}>Cancel</button>
          </form>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td className="code">{point.item_code}</td>
      <td className="wrap">{point.item_name}</td>
      <td className="code">{point.location_code}</td>
      <td className="r">{point.min_qty}</td>
      <td>
        <span className="actions">
          <button type="button" className="ghost tiny" onClick={() => setEditing(true)}>Edit</button>
          <form action={delFormAction} onSubmit={confirmDelete} style={{ display: "inline" }}>
            <input type="hidden" name="id" value={point.id} />
            <button type="submit" className="danger tiny" disabled={delPending}>
              {delPending ? "Removing…" : "Remove"}
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
