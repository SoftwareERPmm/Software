"use client";

import { useEffect, useRef } from "react";

export type Shortfall = {
  itemCode: string;
  itemName: string;
  uomCode: string;
  required: number;
  recorded: number;
};

const qty = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 4 });

/**
 * The question asked before stock is allowed to go negative.
 *
 * Not a warning that can be scrolled past. The ERP is about to record
 * something it has no evidence for — goods leaving that it never saw arrive —
 * and the only thing that makes that legitimate rather than a corrupted
 * balance is a person saying the stock is physically on the shelf. So the
 * question is asked plainly, in those words, and the answer is stored on the
 * document.
 *
 * Every figure is shown per item rather than summarised, because "insufficient
 * stock" across four lines is not a thing anyone can confirm; "Dress: 10
 * required, 0 recorded, −10 projected" is.
 */
export function NegativeStockConfirm({
  open, shortfalls, onCancel, onConfirm,
}: {
  open: boolean;
  shortfalls: Shortfall[];
  onCancel: () => void;
  onConfirm: () => void;
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
      onCancel={(e) => { e.preventDefault(); onCancel(); }}
      onClick={(e) => { if (e.target === ref.current) onCancel(); }}
    >
      <div className="confirm-panel">
        <div className="confirm-icon" aria-hidden="true">⚠️</div>
        <h2 className="confirm-title">Insufficient recorded stock</h2>
        <p className="confirm-detail">
          This will result in negative stock for
          {shortfalls.length === 1 ? " this item" : " these items"}. Recorded
          stock is insufficient &mdash; please confirm that the goods
          physically exist and are available for delivery.
        </p>

        <div className="tablewrap" style={{ marginTop: "0.6rem" }}>
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th className="r">Required</th>
                <th className="r">Recorded stock</th>
                <th className="r">Projected stock</th>
              </tr>
            </thead>
            <tbody>
              {shortfalls.map((s) => (
                <tr key={s.itemCode}>
                  <td className="wrap">
                    {s.itemName}
                    <div className="subline code">{s.itemCode}</div>
                  </td>
                  <td className="r">{qty(s.required)} {s.uomCode}</td>
                  <td className="r">{qty(s.recorded)} {s.uomCode}</td>
                  <td className="r" style={{ color: "var(--bad)" }}>
                    <strong>{qty(s.recorded - s.required)}</strong> {s.uomCode}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="confirm-detail" style={{ marginTop: "0.6rem" }}>
          Confirming is recorded against this document, and the shortfall is
          listed under <strong>Inventory &rarr; Negative stock</strong> until a
          receipt covers it or it is reconciled.
        </p>

        <div className="confirm-actions">
          <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
          <button type="button" className="warn" onClick={onConfirm}>Yes, continue</button>
        </div>
      </div>
    </dialog>
  );
}
