"use client";

import { useActionState, useState } from "react";
import type { ActionResult } from "@/lib/actions";

type Item = { id: string; code: string; name: string };
type Group = { id: string; name: string };

export function VolumeDiscountForm({
  action, items, groups,
}: {
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  items: Item[];
  groups: Group[];
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    action as never, null
  );
  const [open, setOpen] = useState(false);
  const [basis, setBasis] = useState<"QUANTITY" | "INVOICE_TOTAL">("QUANTITY");

  if (!open) {
    return (
      <div className="actions">
        <button type="button" onClick={() => setOpen(true)}>+ Discount band</button>
      </div>
    );
  }

  const byQty = basis === "QUANTITY";

  return (
    <div className="card">
      <div className="card-head">
        <h2>New discount band</h2>
        <span className="actions">
          <button type="button" className="ghost tiny" onClick={() => setOpen(false)}>Cancel</button>
        </span>
      </div>
      <div className="card-body">
        <form action={formAction} className="form">
          {state && "error" in state && <div className="alert">{state.error}</div>}

          <div className="row">
            <div className="field">
              <label htmlFor="basis">Earned by</label>
              <select id="basis" name="basis" value={basis}
                      onChange={(e) => setBasis(e.target.value as typeof basis)}>
                <option value="QUANTITY">Quantity on a line</option>
                <option value="INVOICE_TOTAL">The invoice total</option>
              </select>
              <span className="hint">
                {byQty
                  ? "Read against what one line buys."
                  : "Read against the whole bill, after any line discounts."}
              </span>
            </div>
            <div className="field">
              <label htmlFor="code">Code</label>
              <input id="code" name="code" type="text" required autoFocus placeholder="VOL-100" />
            </div>
            <div className="field">
              <label htmlFor="name">Name</label>
              <input id="name" name="name" type="text" required
                     placeholder={byQty ? "100 or more" : "Bill over 10 million"} />
              <span className="hint">Shown on the invoice as the reason.</span>
            </div>
          </div>

          <div className="row">
            <div className="field">
              <label htmlFor="min_value">{byQty ? "From quantity" : "From amount"}</label>
              <input id="min_value" name="min_value" type="number" min="0" step="any" required
                     placeholder={byQty ? "100" : "10000000"} />
            </div>
            <div className="field">
              <label htmlFor="max_value">{byQty ? "To quantity" : "To amount"}</label>
              <input id="max_value" name="max_value" type="number" min="0" step="any"
                     placeholder="leave blank for no upper limit" />
              <span className="hint">Blank means &ldquo;and above&rdquo;.</span>
            </div>
            <div className="field">
              <label htmlFor="discount_pct">Discount %</label>
              <input id="discount_pct" name="discount_pct" type="number" min="0" max="100"
                     step="any" required placeholder="5" />
            </div>
          </div>

          {/* An invoice-total band applies to the whole bill, so it cannot be
              narrowed to one product — the scope pickers are hidden rather
              than shown and ignored. */}
          {byQty && (
            <div className="row">
              <div className="field">
                <label htmlFor="item_id">Only this item</label>
                <select id="item_id" name="item_id" defaultValue="">
                  <option value="">any item</option>
                  {items.map((i) => (
                    <option key={i.id} value={i.id}>{i.code} · {i.name}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="item_group_id">Or this category</label>
                <select id="item_group_id" name="item_group_id" defaultValue="">
                  <option value="">any category</option>
                  {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
                <span className="hint">
                  A band naming an item beats one naming its category, which
                  beats one naming neither.
                </span>
              </div>
            </div>
          )}

          <div className="row">
            <div className="field">
              <label htmlFor="valid_from">In force from</label>
              <input id="valid_from" name="valid_from" type="date"
                     defaultValue={new Date().toISOString().slice(0, 10)} required />
            </div>
            <div className="field">
              <label htmlFor="valid_to">Until</label>
              <input id="valid_to" name="valid_to" type="date" />
              <span className="hint">Blank means it does not expire.</span>
            </div>
          </div>

          <div className="actions">
            <button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save band"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
