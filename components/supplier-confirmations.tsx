"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { ActionResult } from "@/lib/actions";
import { shortDate } from "@/lib/format";
import { resolveCommitments } from "@/lib/supplier-commitments";
import { HelpHint } from "./help-hint";

export type ConfirmationLine = {
  order_line_id: string;
  line_no: number;
  ordered_qty: string;
  item_code: string | null;
  item_name: string | null;
  confirmations: {
    id: string; qty: number; confirmedDate: string; kind: string;
    recordedOn: string; source: string | null; note: string | null;
  }[];
};

const KIND_LABEL: Record<string, string> = {
  INITIAL: "confirmed",
  SUPPLIER_REVISION: "supplier moved it",
  BUYER_AGREED: "we agreed to move it",
};

/**
 * When the supplier said it would arrive, recorded as they say it.
 *
 * This is the input side of on-time delivery, and it sits on the order
 * rather than on a settings screen because that is where the conversation
 * happens: the acknowledgement arrives, somebody opens the order to check
 * it, and the date should be recordable in the same breath. A metric whose
 * only data entry lives three screens away is a metric that stays empty.
 *
 * Nothing here can be edited or deleted. The panel shows the whole history
 * because a supplier who has moved a date twice is the finding, not an
 * untidy record to be cleaned up.
 */
export function SupplierConfirmations({
  action, documentId, lines,
}: {
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  documentId: string;
  lines: ConfirmationLine[];
}) {
  const router = useRouter();
  const [state, formAction, pending] =
    useActionState<ActionResult | null, FormData>(action as never, null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (state && "ok" in state) { setOpen(null); router.refresh(); }
  }, [state, router]);

  return (
    <div className="card">
      <div className="card-head">
        <div className="headwith">
          <h2>Delivery commitments</h2>
          <HelpHint label="How these are scored">
            What the supplier said, and when they said it. On-time delivery
            is scored against the first promise for each quantity — not the
            last, or a supplier could re-confirm their way to a clean
            record. A change you agreed to moves that baseline; a supplier
            moving their own date does not, because that is the miss.
          </HelpHint>
        </div>
      </div>

      {state && "error" in state && <div className="alert">{state.error}</div>}

      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Line</th>
              <th className="r">Ordered</th>
              <th>Committed</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              // Resolved by the same code the metric uses, so what the
              // buyer reads here is what the supplier will be scored on.
              const resolved = resolveCommitments(
                l.confirmations as never, [], Number(l.ordered_qty));
              const editing = open === l.order_line_id;

              return (
                <tr key={l.order_line_id}>
                  <td className="wrap">
                    <span className="code">{l.item_code}</span>
                    <div className="subline">{l.item_name}</div>
                  </td>
                  <td className="r">{Number(l.ordered_qty)}</td>
                  <td className="wrap">
                    {resolved.baseline.length === 0 ? (
                      <span className="page-sub">
                        Nothing committed — this line is left out of on-time
                        delivery rather than counted against the supplier.
                      </span>
                    ) : (
                      <ul className="commitments">
                        {resolved.baseline.map((b) => (
                          <li key={b.date}>
                            <strong>{b.qty}</strong> by {shortDate(b.date)}
                          </li>
                        ))}
                      </ul>
                    )}

                    {/* The revised schedule only where it differs: showing
                        two identical lists teaches people to skip both. */}
                    {JSON.stringify(resolved.revised) !== JSON.stringify(resolved.baseline) && (
                      <div className="subline">
                        now expected:{" "}
                        {resolved.revised.map((b) => `${b.qty} by ${shortDate(b.date)}`).join(", ")}
                      </div>
                    )}

                    {l.confirmations.length > 0 && (
                      <details className="confirm-history">
                        <summary className="subline">
                          {l.confirmations.length} record
                          {l.confirmations.length === 1 ? "" : "s"}
                        </summary>
                        <ul>
                          {l.confirmations.map((c) => (
                            <li key={c.id}>
                              {c.qty} by {shortDate(c.confirmedDate)} —{" "}
                              {KIND_LABEL[c.kind] ?? c.kind}, told{" "}
                              {shortDate(c.recordedOn)}
                              {c.source ? ` (${c.source})` : ""}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}

                    {resolved.ignored.length > 0 && (
                      <div className="subline" style={{ color: "var(--warn)" }}>
                        {resolved.ignored.length} record
                        {resolved.ignored.length === 1 ? " is" : "s are"} not
                        counted: {resolved.ignored[0].reason}
                      </div>
                    )}
                  </td>
                  <td>
                    {!editing ? (
                      <button type="button" className="ghost"
                              onClick={() => setOpen(l.order_line_id)}>
                        Record a date
                      </button>
                    ) : (
                      <form action={formAction} className="confirm-form">
                        <input type="hidden" name="document_id" value={documentId} />
                        <input type="hidden" name="order_line_id" value={l.order_line_id} />
                        <div className="field">
                          <label htmlFor={`qty-${l.order_line_id}`}>Quantity</label>
                          <input id={`qty-${l.order_line_id}`} name="qty" type="number"
                                 min="0" step="any"
                                 defaultValue={Number(l.ordered_qty)} required />
                        </div>
                        <div className="field">
                          <label htmlFor={`date-${l.order_line_id}`}>Arriving</label>
                          <input id={`date-${l.order_line_id}`} name="confirmed_date"
                                 type="date" required />
                        </div>
                        <div className="field">
                          <label htmlFor={`kind-${l.order_line_id}`}>This is</label>
                          <select id={`kind-${l.order_line_id}`} name="kind"
                                  defaultValue={l.confirmations.length === 0
                                    ? "INITIAL" : "SUPPLIER_REVISION"}>
                            <option value="INITIAL">their first commitment</option>
                            <option value="SUPPLIER_REVISION">
                              the supplier moving their date
                            </option>
                            <option value="BUYER_AGREED">
                              a change we asked for or agreed
                            </option>
                          </select>
                          <div className="subline">
                            A change we agreed to moves the baseline. A supplier
                            moving their own date does not — that is the miss.
                          </div>
                        </div>
                        <div className="field">
                          <label htmlFor={`src-${l.order_line_id}`}>How we know</label>
                          <input id={`src-${l.order_line_id}`} name="source"
                                 placeholder="their acknowledgement, a call" />
                        </div>
                        <div className="actions">
                          <button type="submit" disabled={pending}>
                            {pending ? "Recording…" : "Record"}
                          </button>
                          <button type="button" className="ghost"
                                  onClick={() => setOpen(null)}>Cancel</button>
                        </div>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
