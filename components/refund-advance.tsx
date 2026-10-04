"use client";

import { useActionState, useState } from "react";
import { refundAdvanceAction } from "@/lib/actions";
import type { ActionResult } from "@/lib/actions";

/**
 * Hand an advance back, from the row that holds it.
 *
 * Opened in place rather than on a page of its own: the amount left on
 * account is right there in the row, and that is what somebody refunding
 * needs to see while deciding how much. Defaults to all of it and can be
 * lowered — refunding part leaves the rest available to apply.
 *
 * Offered only while something is left. What has been applied has settled a
 * bill, and the engine refuses to give it back a second time.
 */
export function RefundAdvance({
  paymentId, remaining, customer, cashAccounts, today,
}: {
  paymentId: string;
  remaining: number;
  customer: boolean;
  cashAccounts: { id: string; code: string; name: string }[];
  today: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    refundAdvanceAction, null);
  /* One key per opened form, so a second click on Refund is recognised as
     the same attempt rather than a second refund of the same money. */
  const [attemptKey] = useState(() => crypto.randomUUID());

  /* The form opens as a panel anchored under the button rather than inside
     the cell. Laid out in the cell it was wider than the column, and the
     whole table scrolled sideways to make room for it. */
  return (
    <span className="refundwrap">
      <button type="button" className="ghost tiny" aria-expanded={open}
              onClick={() => setOpen(!open)}>
        Refund
      </button>
      {open && (
    <form action={formAction} className="refundform">
      <input type="hidden" name="payment_id" value={paymentId} />
      <input type="hidden" name="idempotency_key" value={attemptKey} />
      <label>
        <span>Amount</span>
        <input name="amount" type="number" step="any" min="0" max={remaining}
               defaultValue={remaining} required />
      </label>
      <label>
        <span>{customer ? "Paid out of" : "Received into"}</span>
        <select name="cash_account_id" required defaultValue={cashAccounts[0]?.id ?? ""}>
          {cashAccounts.map((a) => (
            <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
          ))}
        </select>
      </label>
      <label>
        <span>Date</span>
        <input name="doc_date" type="date" defaultValue={today} required />
      </label>
      <label className="wide">
        <span>Why</span>
        <input name="memo" placeholder={customer ? "Order cancelled" : "Deposit returned"} />
      </label>
      {state && "error" in state && state.error && (
        <p className="alert">{state.error}</p>
      )}
      <div className="actions">
        <button type="button" className="ghost" onClick={() => setOpen(false)}
                disabled={pending}>Cancel</button>
        <button type="submit" className="warn" disabled={pending}>
          {pending ? "Refunding…" : customer ? "Refund to customer" : "Record money back"}
        </button>
      </div>
    </form>
      )}
    </span>
  );
}
