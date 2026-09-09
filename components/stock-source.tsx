"use client";

import { useEffect, useRef } from "react";
import { Check, X } from "lucide-react";

export type Pool = {
  /** "OWNED", or the consignor's id. */
  key: string;
  label: string;
  sub: string;
  qty: number;
  effect: string;
};

export type OwnershipSplit = {
  owned: number;
  consigned: { consignorId: string; code: string; name: string; qty: number }[];
};

/** Every pool this item sits in at this warehouse, in the order to offer them. */
export function poolsFor(split: OwnershipSplit | undefined): Pool[] {
  if (!split) return [];
  const pools: Pool[] = [{
    key: "OWNED",
    label: "Company-owned stock",
    sub: "Your own inventory",
    qty: split.owned,
    effect: "Drawn from your FIFO layers, and their cost becomes cost of sales.",
  }];
  for (const c of split.consigned) {
    pools.push({
      key: c.consignorId,
      label: `Consignment — ${c.name}`,
      sub: `Owned by ${c.name}`,
      qty: c.qty,
      effect:
        "Not your inventory, so your stock value does not change. Selling it "
        + "creates what you owe the consignor, settled at the agreed rate.",
    });
  }
  return pools;
}

/**
 * Which pool a line takes its goods from.
 *
 * The hundred shirts on the shelf are not all yours, and nothing in the
 * warehouse says which is which. Sixty are stock you bought and carry as an
 * asset; forty belong to two consignors and are somebody else's goods you
 * happen to be holding. Sell one of theirs and your inventory should not move
 * at all — what moves is what you now owe them.
 *
 * So this is chosen on the line, not inferred afterwards from the accounts.
 * By the time an entry has been posted the information is gone: a credit to
 * inventory looks the same whoever's shirt it was.
 */
export function StockSourceDialog({
  open, itemLabel, pools, value, onPick, onClose,
}: {
  open: boolean;
  itemLabel: string;
  pools: Pool[];
  value: string;
  onPick: (key: string) => void;
  onClose: () => void;
}) {
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
      className="confirm"
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
    >
      <div className="confirm-panel sourcepanel">
        <div className="card-head">
          <h2>Stock source — {itemLabel}</h2>
          <button type="button" className="ghost tiny" aria-label="Close" onClick={onClose}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>

        <div className="card-body">
          {pools.length === 0 && (
            <p className="hint">Nothing is on hand for this item at this warehouse.</p>
          )}
          {pools.map((p) => {
            const chosen = p.key === value;
            const empty = p.qty <= 0;
            return (
              <button
                key={p.key}
                type="button"
                className={`pool ${chosen ? "chosen" : ""}`}
                disabled={empty}
                onClick={() => { onPick(p.key); onClose(); }}
              >
                <span className={`pooldot ${p.key === "OWNED" ? "owned" : "consigned"}`} />
                <span className="poolbody">
                  <span className="poolhead">
                    <strong>{p.label}</strong>
                    {chosen && <Check size={14} aria-hidden="true" />}
                  </span>
                  <span className="poolsub">{p.sub}</span>
                  <span className={`poolqty ${empty ? "none" : ""}`}>
                    {empty ? "None available" : `Available: ${p.qty} pcs`}
                  </span>
                  <span className="pooleffect">{p.effect}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </dialog>
  );
}
