"use client";

import { useActionState, useState } from "react";
import type { ActionResult } from "@/lib/actions";

export function AddUnitForm({
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
        <button type="button" onClick={() => setOpen(true)}>+ Unit</button>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>New unit</h2>
        <span className="actions">
          <button type="button" className="ghost tiny" onClick={() => setOpen(false)}>Cancel</button>
        </span>
      </div>
      <div className="card-body">
        <form action={formAction} className="form">
          {state && "error" in state && <div className="alert">{state.error}</div>}

          <div className="row">
            <div className="field">
              <label htmlFor="code">Code</label>
              <input id="code" name="code" type="text" required autoFocus placeholder="BTL" />
              <span className="hint">Short and typeable. Shown on documents.</span>
            </div>
            <div className="field">
              <label htmlFor="name">Name</label>
              <input id="name" name="name" type="text" required placeholder="Bottle" />
              <span className="hint">
                Written out in full &mdash; the importer matches on this, and will not
                read &ldquo;Btl&rdquo; as &ldquo;Bottle&rdquo;.
              </span>
            </div>
            <div className="field">
              <label htmlFor="name_my">Name (Burmese)</label>
              <input id="name_my" name="name_my" type="text" />
            </div>
          </div>

          <div className="actions">
            <button type="submit" disabled={pending}>{pending ? "Saving…" : "Save unit"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
