"use client";

import { useActionState, useState } from "react";
import type { ActionResult } from "@/lib/actions";
import { ConfirmDelete } from "./confirm-delete";

export type PriceLevel = {
  id: string; code: string; name: string; sort_order: number;
  /** How much is riding on this level, so the row can say so before it is changed. */
  prices?: number; partners?: number;
};

/**
 * Setup creates Wholesale and Retail and there was no way to add a third,
 * so a business with a staff price or an export price had nowhere to put
 * it. Collapsed until asked for, like the unit form, because the common
 * visit to this page is to change a price rather than to add a level.
 */
export function AddPriceLevelForm({
  action,
}: {
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    action as never,
    null
  );
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <div className="actions">
        <button type="button" onClick={() => setOpen(true)}>+ Price level</button>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>New price level</h2>
        <span className="actions">
          <button type="button" className="ghost tiny" onClick={() => setOpen(false)}>Cancel</button>
        </span>
      </div>
      <div className="card-body">
        <form action={formAction} className="form">
          {state && "error" in state && <div className="alert">{state.error}</div>}

          <div className="row">
            <div className="field">
              <label htmlFor="pl-code">Code</label>
              <input id="pl-code" name="code" type="text" required autoFocus placeholder="STAFF" />
              <span className="hint">Short and typeable.</span>
            </div>
            <div className="field">
              <label htmlFor="pl-name">Name</label>
              <input id="pl-name" name="name" type="text" required placeholder="Staff price" />
              <span className="hint">
                The column heading on the price list, and what a customer is put on.
              </span>
            </div>
          </div>

          <div className="actions">
            <button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save price level"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function PriceLevelRow({
  level, first, updateAction, deleteAction,
}: {
  level: PriceLevel;
  /** The level customers on no level are quoted — worth saying out loud. */
  first: boolean;
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

  const inUse = (level.prices ?? 0) > 0 || (level.partners ?? 0) > 0;

  if (editing) {
    return (
      <tr>
        <td colSpan={5}>
          <form action={formAction} className="form" style={{ padding: "0.5rem 0" }}>
            {state && "error" in state && <div className="alert">{state.error}</div>}
            <input type="hidden" name="id" value={level.id} />
            <div className="row">
              <div className="field">
                <label>Code</label>
                <input name="code" type="text" defaultValue={level.code} required />
              </div>
              <div className="field">
                <label>Name</label>
                <input name="name" type="text" defaultValue={level.name} required />
              </div>
              <div className="field">
                <label>Order</label>
                <input name="sort_order" type="number" min={1} step={1}
                       defaultValue={level.sort_order} required />
                <span className="hint">
                  Lowest first. The first level is what a customer on none is quoted.
                </span>
              </div>
            </div>
            {inUse && (
              <div className="hint" style={{ marginTop: "0.4rem" }}>
                {level.prices ?? 0} price{(level.prices ?? 0) === 1 ? "" : "s"} and{" "}
                {level.partners ?? 0} customer{(level.partners ?? 0) === 1 ? "" : "s"} use this
                level. Renaming it changes what it is called, not what anything costs.
              </div>
            )}
            <div className="actions" style={{ marginTop: "0.5rem" }}>
              <button type="submit" disabled={pending}>{pending ? "Saving…" : "Save"}</button>
              <button type="button" className="ghost tiny"
                      onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </form>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td className="code">{level.code}</td>
      <td className="wrap">
        {level.name}
        {first && <div className="subline">quoted when a customer is on no level</div>}
      </td>
      <td className="r">{level.sort_order}</td>
      <td className="r">
        {level.prices ?? 0}
        {(level.partners ?? 0) > 0 && (
          <div className="subline">{level.partners} customer{level.partners === 1 ? "" : "s"}</div>
        )}
      </td>
      <td>
        <span className="actions">
          <button type="button" className="ghost tiny" onClick={() => setEditing(true)}>Edit</button>
          <ConfirmDelete
            action={delFormAction}
            pending={delPending}
            className="ghost tiny"
            error={delState && "error" in delState ? delState.error : null}
            title={`Delete ${level.name}?`}
            detail={
              inUse
                ? `${level.prices ?? 0} price${(level.prices ?? 0) === 1 ? "" : "s"} and ${level.partners ?? 0} customer${(level.partners ?? 0) === 1 ? "" : "s"} use this level, so this will be refused.`
                : "This cannot be undone."
            }
          >
            <input type="hidden" name="id" value={level.id} />
          </ConfirmDelete>
        </span>
        {delState && "error" in delState && (
          <div className="hint" style={{ color: "var(--bad)" }}>{delState.error}</div>
        )}
      </td>
    </tr>
  );
}
