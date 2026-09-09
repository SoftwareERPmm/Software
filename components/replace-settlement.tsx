"use client";

import { useActionState } from "react";
import { RotateCcw } from "lucide-react";
import type { ActionResult } from "@/lib/actions";

/**
 * The way back from a voided consignment settlement.
 *
 * A void reverses what the shop owed the consignor, and the goods it covered
 * are still sold. Without this the sale sat with the consignor's stock gone
 * and their money cancelled, and nothing in the product could put it right —
 * the only thing that raises a settlement runs during a posting that has
 * already happened.
 */
export function ReplaceSettlement({
  action, invoiceId, unsettled,
}: {
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  invoiceId: string;
  unsettled: { qty: string; item_code: string; item_name: string; consignor_name: string }[];
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    action as never, null,
  );

  return (
    <form action={formAction} className="alert" style={{ marginBottom: "1rem" }}>
      <input type="hidden" name="invoice_id" value={invoiceId} />
      <strong>This sale owes a consignor and has no settlement standing.</strong>
      <ul style={{ margin: "0.4rem 0 0.6rem 1.1rem" }}>
        {unsettled.map((u, i) => (
          <li key={i}>
            {Number(u.qty)} × {u.item_code} {u.item_name} — {u.consignor_name}
          </li>
        ))}
      </ul>
      {state && "error" in state && (
        <div style={{ color: "var(--bad)", marginBottom: "0.4rem" }}>{state.error}</div>
      )}
      <button type="submit" disabled={pending}>
        <RotateCcw size={14} aria-hidden="true" />
        {pending ? "Posting…" : "Raise a replacement settlement"}
      </button>
    </form>
  );
}
