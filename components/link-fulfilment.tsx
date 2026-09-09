"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useActionState } from "react";
import { Link2, Truck } from "lucide-react";
import Link from "next/link";
import type { ActionResult } from "@/lib/actions";

export type OrderLine = {
  orderLineId: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  outstanding: number;
};

export type Candidate = {
  lineId: string;
  itemId: string;
  documentId: string;
  docNo: string;
  docDate: string;
  /** The invoice or order that document was raised against, where there was one. */
  relatedNo: string | null;
  spare: number;
};

const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });

/**
 * The goods already arrived — said from the order's side.
 *
 * The same allocation the receipt offers, asked where somebody is standing
 * when they notice the problem: on an order reading "40 of 100 received"
 * with the other sixty sitting on a receipt that never named it. Making them
 * find that receipt first, to say a thing about this order, is the kind of
 * navigation that means the correction does not get made.
 *
 * It writes no stock movement and no journal entry. The goods arrived once,
 * were valued once, and are already in the books; all that changes is which
 * order they answered.
 */
export function LinkFulfilment({
  action, orderLines, candidates, sales,
}: {
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  orderLines: OrderLine[];
  candidates: Candidate[];
  sales: boolean;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    action as never, null,
  );
  const [open, setOpen] = useState(false);

  const forItem = useMemo(() => {
    const by = new Map<string, Candidate[]>();
    for (const c of candidates) {
      const list = by.get(c.itemId) ?? [];
      list.push(c);
      by.set(c.itemId, list);
    }
    return by;
  }, [candidates]);

  const usable = orderLines.filter((l) => (forItem.get(l.itemId)?.length ?? 0) > 0);

  // One candidate for a line is not a question: open on it, with the quantity
  // filled to whatever both sides can still give.
  const [picks, setPicks] = useState<Record<string, { lineId: string; qty: string }>>(() => {
    const seed: Record<string, { lineId: string; qty: string }> = {};
    for (const l of orderLines) {
      const only = candidates.filter((c) => c.itemId === l.itemId);
      if (only.length !== 1) continue;
      seed[l.orderLineId] = {
        lineId: only[0].lineId,
        qty: String(Math.min(l.outstanding, only[0].spare)),
      };
    }
    return seed;
  });

  if (usable.length === 0) return null;

  const allocations = usable
    .map((l) => {
      const pick = picks[l.orderLineId];
      if (!pick?.lineId || !(Number(pick.qty) > 0)) return null;
      return { fulfilmentLineId: pick.lineId, orderLineId: l.orderLineId, qty: Number(pick.qty) };
    })
    .filter(Boolean);

  const word = sales ? "delivery" : "receipt";

  return (
    <>
      <button type="button" className="btn ghost" onClick={() => setOpen(true)}>
        <Link2 size={14} aria-hidden="true" /> Link existing {word}
      </button>

      <Dialog open={open} onClose={() => setOpen(false)}>
        <form action={formAction}>
          <input type="hidden" name="allocations" value={JSON.stringify(allocations)} />
          <div className="card-head">
            <h2>Which {word} {sales ? "sent" : "brought"} these goods?</h2>
            <span className="page-sub">
              Changes what this order is owed. No stock moves and no entry is written.
            </span>
          </div>

          {state && "error" in state && <div className="alert">{state.error}</div>}

          <div className="tablewrap">
            <table className="linetable">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="r">Still outstanding</th>
                  <th>{sales ? "Delivery" : "Goods receipt"}</th>
                  <th className="r">Quantity</th>
                </tr>
              </thead>
              <tbody>
                {usable.map((l) => {
                  const options = forItem.get(l.itemId) ?? [];
                  const pick = picks[l.orderLineId] ?? { lineId: "", qty: "" };
                  const chosen = options.find((o) => o.lineId === pick.lineId);
                  return (
                    <tr key={l.orderLineId}>
                      <td className="wrap">
                        <span className="code">{l.itemCode}</span> · {l.itemName}
                      </td>
                      <td className="r">{fmt(l.outstanding)}</td>
                      <td>
                        <select
                          value={pick.lineId}
                          onChange={(e) => {
                            const o = options.find((x) => x.lineId === e.target.value);
                            setPicks((p) => ({
                              ...p,
                              [l.orderLineId]: {
                                lineId: e.target.value,
                                qty: o ? String(Math.min(l.outstanding, o.spare)) : "",
                              },
                            }));
                          }}
                        >
                          <option value="">Not from an existing {word}</option>
                          {options.map((o) => (
                            <option key={o.lineId} value={o.lineId}>
                              {o.docNo} · {o.docDate} · {fmt(o.spare)} unallocated
                              {o.relatedNo ? ` · against ${o.relatedNo}` : ""}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="narrow">
                        <input
                          type="number" min="0" step="any" value={pick.qty}
                          aria-label={`Quantity of ${l.itemCode} from that ${word}`}
                          max={chosen ? Math.min(l.outstanding, chosen.spare) : l.outstanding}
                          onChange={(e) => setPicks((p) => ({
                            ...p,
                            [l.orderLineId]: { lineId: pick.lineId, qty: e.target.value },
                          }))}
                          disabled={!pick.lineId}
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
              <label htmlFor="fulfil_reason">Why</label>
              <input id="fulfil_reason" name="reason" type="text"
                     placeholder={sales
                       ? "e.g. delivered against the customer's invoice"
                       : "e.g. received against the supplier's invoice"} />
              <span className="hint">Kept with the link, alongside the date.</span>
            </div>
          </div>

          <div className="actions">
            <button type="submit" disabled={pending || allocations.length === 0}>
              {pending ? "Linking…" : "Link to this order"}
            </button>
            <button type="button" className="ghost" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

function Dialog({
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

/** The pair of actions an open order offers: fulfil it, or say it was. */
export function OrderActions({
  href, sales, children,
}: { href: string; sales: boolean; children?: React.ReactNode }) {
  return (
    <div className="docactions">
      <Link href={href} className="btn">
        <Truck size={14} aria-hidden="true" /> {sales ? "Deliver goods" : "Receive goods"}
      </Link>
      {children}
    </div>
  );
}
