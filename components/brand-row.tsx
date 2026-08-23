"use client";

import { useActionState, useState } from "react";
import type { ActionResult } from "@/lib/actions";
import { ConfirmDelete } from "./confirm-delete";

type Brand = { id: string; code: string; name: string; name_my: string | null; is_active: boolean; items?: number };

export function BrandRow({
  brand,
  updateAction,
  deleteAction,
  deactivateAction,
  activateAction,
}: {
  brand: Brand;
  updateAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  deleteAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  deactivateAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  activateAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
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
  const [, actFormAction] = useActionState<ActionResult | null, FormData>(
    activateAction as never,
    null
  );
  const [delState, delFormAction, delPending] = useActionState<ActionResult | null, FormData>(
    deleteAction as never,
    null
  );


  if (editing) {
    return (
      <tr>
        <td colSpan={5}>
          <form action={formAction} className="form" style={{ padding: "0.5rem 0" }}>
            {state && "error" in state && <div className="alert">{state.error}</div>}
            <input type="hidden" name="id" value={brand.id} />
            <div className="row">
              <div className="field">
                <label>Code</label>
                <input name="code" type="text" defaultValue={brand.code} required />
              </div>
              <div className="field">
                <label>Name</label>
                <input name="name" type="text" defaultValue={brand.name} required />
              </div>
              <div className="field">
                <label>Name (Burmese)</label>
                <input name="name_my" type="text" defaultValue={brand.name_my ?? ""} />
              </div>
            </div>
            <label className="check" style={{ marginTop: "0.4rem" }}>
              <input name="is_active" type="checkbox" defaultChecked={brand.is_active} />
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
      <td className="code">{brand.code}</td>
      <td className="wrap">
        {brand.name}
        {brand.name_my && (
          <div className="subline">{brand.name_my}</div>
        )}
      </td>
      <td className="r">{brand.items || ""}</td>
      <td>{brand.is_active ? <span className="pill ok">active</span> : <span className="pill warn">inactive</span>}</td>
      <td>
        <span className="actions">
          <button type="button" className="ghost tiny" onClick={() => setEditing(true)}>Edit</button>
          {brand.is_active ? (
            <form action={deactFormAction} style={{ display: "inline" }}>
              <input type="hidden" name="id" value={brand.id} />
              <button type="submit" className="warn tiny">Deactivate</button>
            </form>
          ) : (
            <form action={actFormAction} style={{ display: "inline" }}>
              <input type="hidden" name="id" value={brand.id} />
              <button type="submit" className="ghost tiny">Reactivate</button>
            </form>
          )}
          <ConfirmDelete
            action={delFormAction}
            pending={delPending}
            error={delState && "error" in delState ? delState.error : null}
            title={`Delete ${brand.name}?`}
            detail="This cannot be undone."
          >
            <input type="hidden" name="id" value={brand.id} />
          </ConfirmDelete>
        </span>
        {delState && "error" in delState && (
          <div className="hint" style={{ color: "var(--bad)" }}>{delState.error}</div>
        )}
      </td>
    </tr>
  );
}
