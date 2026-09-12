"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useActionState } from "react";
import { Wallet, X } from "lucide-react";
import { money } from "@/lib/format";
import type { ActionResult } from "@/lib/actions";

export type OpenAdvance = {
  paymentId: string;
  docNo: string;
  docDate: string;
  available: number;
};

/**
 * Money already received, put against this bill.
 *
 * No cash moves and no second receipt is written — that is the whole point.
 * Somebody who took a deposit and then invoiced for the goods is one keystroke
 * away from recording the money twice, and the honest version of that flow is
 * to point the money that is already in the books at the bill that has just
 * appeared.
 *
 * A panel rather than a page, because it is a decision about the document
 * behind it: how much of which advance, and what would be left to collect
 * afterwards. Leaving the invoice to answer that and coming back is how the
 * wrong figure gets applied.
 */
export function ApplyAdvance({
  action, invoiceId, invoiceNo, outstanding, advances, sales,
}: {
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  invoiceId: string;
  invoiceNo: string;
  outstanding: number;
  advances: OpenAdvance[];
  sales: boolean;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    action as never, null,
  );
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);

  const total = advances.reduce((t, a) => t + a.available, 0);

  /**
   * One advance and one invoice is not a question. It opens with as much of
   * the money applied as the bill can take, which is what somebody reaching
   * for this almost always wants — and is still a figure they can change
   * before confirming.
   */
  const [picks, setPicks] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    let left = outstanding;
    for (const a of advances) {
      const use = Math.min(a.available, left);
      if (use <= 0) break;
      seed[a.paymentId] = String(use);
      left -= use;
    }
    return seed;
  });

  const applying = useMemo(
    () => advances.reduce((t, a) => t + (Number(picks[a.paymentId]) || 0), 0),
    [advances, picks],
  );

  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [open]);

  if (advances.length === 0 || outstanding <= 0.0001) return null;

  const over = applying > outstanding + 0.0001;
  const payload = advances
    .map((a) => ({ paymentId: a.paymentId, amount: Number(picks[a.paymentId]) || 0 }))
    .filter((a) => a.amount > 0);

  return (
    <>
      <div className="advbanner">
        <Wallet size={15} aria-hidden="true" />
        <span>
          Available advance: <strong>{money(total)} MMK</strong>
          <span className="advbanner-why">
            {" "}— money {sales ? "this customer has already paid" : "already paid to this supplier"}
          </span>
        </span>
        <button type="button" className="btn" onClick={() => setOpen(true)}>
          Apply advance
        </button>
      </div>

      {open && (
        <>
          <div className="advscrim" onClick={() => setOpen(false)} />
          <aside className="advpanel" ref={panel} role="dialog" aria-label="Apply advance">
            <form action={formAction}>
              <input type="hidden" name="invoice_id" value={invoiceId} />
              <input type="hidden" name="allocations" value={JSON.stringify(payload)} />

              <header className="advpanel-head">
                <div>
                  <h2>Apply {sales ? "customer" : "supplier"} advance</h2>
                  <span className="page-sub">{invoiceNo}</span>
                </div>
                <button type="button" className="ghost tiny" onClick={() => setOpen(false)}
                        aria-label="Close">
                  <X size={16} aria-hidden="true" />
                </button>
              </header>

              {state && "error" in state && <div className="alert">{state.error}</div>}

              <div className="advpanel-body">
                <h3>Select advance to apply</h3>
                <table className="linetable">
                  <thead>
                    <tr>
                      <th>Received</th>
                      <th className="r">Available</th>
                      <th className="r">Apply now</th>
                    </tr>
                  </thead>
                  <tbody>
                    {advances.map((a) => (
                      <tr key={a.paymentId}>
                        <td className="wrap">
                          <strong>{a.docNo}</strong>
                          <div className="page-sub">{a.docDate}</div>
                        </td>
                        <td className="r">{money(a.available)}</td>
                        <td className="narrow">
                          <input
                            type="number" min="0" max={a.available} step="any"
                            aria-label={`Apply from ${a.docNo}`}
                            value={picks[a.paymentId] ?? ""}
                            onChange={(e) =>
                              setPicks((p) => ({ ...p, [a.paymentId]: e.target.value }))}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <div className="advpreview">
                  <h3>After applying</h3>
                  <dl>
                    {/* What the invoice still owes, which is not the same as
                        what it was raised for — a bill already part paid would
                        otherwise be labelled with a figure it has not carried
                        for weeks. */}
                    <dt>Outstanding before this</dt>
                    <dd>{money(outstanding)} MMK</dd>
                    <dt>Advance to apply</dt>
                    <dd>−{money(applying)} MMK</dd>
                    <dt className="strong">
                      Remaining to {sales ? "collect" : "pay"}
                    </dt>
                    <dd className="strong">{money(outstanding - applying)} MMK</dd>
                    <dt>Unused advance remaining</dt>
                    <dd>{money(total - applying)} MMK</dd>
                  </dl>
                  <p className="page-sub">
                    Uses money already {sales ? "received" : "paid"}. No new
                    {sales ? " receipt" : " payment"} is created.
                  </p>
                </div>

                {over && (
                  <div className="alert">
                    That is more than {invoiceNo} still owes. Whatever is left over stays
                    on account for the next one.
                  </div>
                )}
              </div>

              <footer className="advpanel-foot">
                <button type="submit" disabled={pending || over || applying <= 0}>
                  {pending ? "Applying…" : `Apply ${money(applying)}`}
                </button>
                <button type="button" className="ghost" onClick={() => setOpen(false)}>
                  Cancel
                </button>
              </footer>
            </form>
          </aside>
        </>
      )}
    </>
  );
}
