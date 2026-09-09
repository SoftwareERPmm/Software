"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useActionState } from "react";
import { Link2 } from "lucide-react";
import type { ActionResult } from "@/lib/actions";

export type FulfilmentLine = {
  lineId: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  qty: number;
  /** Already allocated to some order, so not available again. */
  allocated: number;
};

export type OpenOrderLine = {
  orderId: string;
  orderNo: string;
  orderLineId: string;
  itemId: string;
  outstanding: number;
  dueDate: string | null;
};

const fmt = (n: number) =>
  n.toLocaleString(undefined, { maximumFractionDigits: 4 });

/**
 * These goods answered that order — said after the fact.
 *
 * A receipt names one source. Matched to the invoice that billed for it, or
 * raised with no order chosen at all, it leaves the purchase order behind it
 * at nothing received: the goods are on the shelf and the order turns overdue
 * behind them. Nothing can work that out afterwards from the item alone — two
 * orders for the same product, and the guess closes the wrong one — so
 * somebody says which, here, and the saying is recorded.
 *
 * It is deliberately not a posting. No stock moves, no entry is written: the
 * goods already arrived and were already valued. All that changes is what the
 * order says it is still owed.
 *
 * Asked in a dialog rather than unfolded into the page. Inline it pushed the
 * document down and left a half-filled form sitting among the facts, which
 * reads as though the allocation were part of the record rather than a
 * question being asked about it.
 */
export function LinkToOrder({
  action, lines, openLines,
}: {
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  lines: FulfilmentLine[];
  openLines: OpenOrderLine[];
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    action as never, null,
  );
  const [open, setOpen] = useState(false);

  /**
   * A line with exactly one order it could answer is not a question. The
   * dialog opened on "Not against an order" — the one choice that does
   * nothing — above a list containing the single order these goods were for,
   * and waited to be told what it already knew.
   */
  const [picks, setPicks] = useState<Record<string, { orderLineId: string; qty: string }>>(() => {
    const seed: Record<string, { orderLineId: string; qty: string }> = {};
    for (const l of lines) {
      const spare = l.qty - l.allocated;
      if (spare <= 0.0001) continue;
      const only = openLines.filter((o) => o.itemId === l.itemId);
      if (only.length !== 1) continue;
      seed[l.lineId] = {
        orderLineId: only[0].orderLineId,
        qty: String(Math.min(spare, only[0].outstanding)),
      };
    }
    return seed;
  });

  // Only lines with something left to give, and only orders that still want
  // that item. An empty panel is better than a panel of impossible choices.
  const linkable = lines.filter((l) => l.qty - l.allocated > 0.0001);
  const ordersFor = useMemo(() => {
    const by = new Map<string, OpenOrderLine[]>();
    for (const o of openLines) {
      const list = by.get(o.itemId) ?? [];
      list.push(o);
      by.set(o.itemId, list);
    }
    return by;
  }, [openLines]);

  const usable = linkable.filter((l) => (ordersFor.get(l.itemId)?.length ?? 0) > 0);
  if (usable.length === 0) return null;

  const allocations = usable
    .map((l) => {
      const pick = picks[l.lineId];
      if (!pick?.orderLineId || !(Number(pick.qty) > 0)) return null;
      return { fulfilmentLineId: l.lineId, orderLineId: pick.orderLineId, qty: Number(pick.qty) };
    })
    .filter(Boolean);

  return (
    <>
      <div className="docactions">
        <button type="button" className="btn ghost" onClick={() => setOpen(true)}>
          <Link2 size={14} aria-hidden="true" /> Link to a purchase order
        </button>
      </div>

      <LinkDialog open={open} onClose={() => setOpen(false)}>
        <form action={formAction}>
          <input type="hidden" name="allocations" value={JSON.stringify(allocations)} />
          <div className="card-head">
            <h2>Which order did these goods answer?</h2>
            <span className="page-sub">
              Changes what the order is owed. No stock moves and no entry is written.
            </span>
          </div>

          {state && "error" in state && <div className="alert">{state.error}</div>}

          <div className="tablewrap">
            <table className="linetable">
          <thead>
            <tr>
              <th>Item</th>
              <th className="r">Not yet allocated</th>
              <th>Order</th>
              <th className="r">Quantity</th>
            </tr>
          </thead>
          <tbody>
            {usable.map((l) => {
              const spare = l.qty - l.allocated;
              const options = ordersFor.get(l.itemId) ?? [];
              const pick = picks[l.lineId] ?? { orderLineId: "", qty: "" };
              const chosen = options.find((o) => o.orderLineId === pick.orderLineId);
              return (
                <tr key={l.lineId}>
                  <td className="wrap">
                    <span className="code">{l.itemCode}</span> · {l.itemName}
                  </td>
                  <td className="r">{fmt(spare)} of {fmt(l.qty)}</td>
                  <td>
                    <select
                      value={pick.orderLineId}
                      onChange={(e) => {
                        const o = options.find((x) => x.orderLineId === e.target.value);
                        setPicks((p) => ({
                          ...p,
                          [l.lineId]: {
                            orderLineId: e.target.value,
                            // The obvious quantity, which is as much of it as
                            // this line can still give.
                            qty: o ? String(Math.min(spare, o.outstanding)) : "",
                          },
                        }));
                      }}
                    >
                      <option value="">Not against an order</option>
                      {options.map((o) => (
                        <option key={o.orderLineId} value={o.orderLineId}>
                          {o.orderNo} · {fmt(o.outstanding)} outstanding
                          {o.dueDate ? ` · needed ${o.dueDate}` : ""}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="narrow">
                    <input
                      type="number" min="0" step="any" value={pick.qty}
                      aria-label={`Quantity of ${l.itemCode} against that order`}
                      max={chosen ? Math.min(spare, chosen.outstanding) : spare}
                      onChange={(e) => setPicks((p) => ({
                        ...p,
                        [l.lineId]: { orderLineId: pick.orderLineId, qty: e.target.value },
                      }))}
                      disabled={!pick.orderLineId}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="card-body">
        <div className="field">
          <label htmlFor="link_reason">Why</label>
          <input id="link_reason" name="reason" type="text"
                 placeholder="e.g. received against the supplier's invoice" />
          <span className="hint">Kept with the link, alongside the date.</span>
        </div>
      </div>

          <div className="actions">
            <button type="submit" disabled={pending || allocations.length === 0}>
              {pending ? "Linking…" : "Link to order"}
            </button>
            <button type="button" className="ghost" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      </LinkDialog>
    </>
  );
}

/**
 * A modal that closes on Escape and on the backdrop, and does not trap the
 * reader in a decision they opened by accident.
 */
function LinkDialog({
  open, onClose, children,
}: { open: boolean; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="confirm confirm-wide"
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
    >
      <div className="confirm-panel linkpanel">{children}</div>
    </dialog>
  );
}
