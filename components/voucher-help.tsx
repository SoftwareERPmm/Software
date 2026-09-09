"use client";

import { useEffect, useRef, useState } from "react";
import { CircleHelp, X } from "lucide-react";

/**
 * What a journal is for, and what it is not for.
 *
 * A dialog rather than a paragraph on the page: it is read once by a new
 * bookkeeper and never again by anyone, and prose that answers a question
 * nobody is asking any more is what pushes the form itself below the fold.
 *
 * The content is not general accounting advice. It says what this system
 * will actually refuse, so someone reads it before meeting the refusal
 * rather than afterwards.
 */

const CONTENT: Record<string, { title: string; use: string[]; not: string[]; note: string }> = {
  journal: {
    title: "When to use a journal",
    use: [
      "Depreciation — writing down what an asset is worth this month",
      "Accruals — an expense incurred before the bill arrives",
      "Reclassification — moving a balance between two accounts",
      "Year-end adjustments your accountant asks for",
      "Correcting an earlier journal, by posting the difference",
    ],
    not: [
      "Sales — raise a sales invoice, so revenue and the receivable agree",
      "Purchases — raise a purchase invoice against its goods receipt",
      "Money in or out — use a receipt, a payment, or a cash voucher",
      "Stock — a goods receipt, delivery, adjustment or transfer moves it",
      "Opening balances — the opening setup posts those once, with the stock",
    ],
    note:
      "Receivables, payables, inventory and GR/IR are maintained by their own "
      + "subledgers, so this form will not offer them and the database will "
      + "refuse them. That is deliberate: a journal into inventory changes what "
      + "the stock is worth without changing what the stock is.",
  },
  cash: {
    title: "When to use a cash voucher",
    use: [
      "Paying an expense out of the till — rent, tea money, a repair",
      "Miscellaneous cash coming in that is not a customer paying a bill",
      "Moving cash between your own tills, with a transfer",
    ],
    not: [
      "Paying a supplier bill — use Pay supplier, so the bill is settled",
      "A customer paying an invoice — use Receive payment",
      "Anything with no cash in it — that is a journal",
    ],
    note:
      "Settling a bill through here would pay the money and leave the invoice "
      + "open, so the supplier's balance would never come down.",
  },
  bank: {
    title: "When to use a bank voucher",
    use: [
      "Bank charges, interest, and other entries the bank makes",
      "Money arriving or leaving the account that is not a customer or supplier",
    ],
    not: [
      "Paying a supplier bill — use Pay supplier",
      "A customer paying an invoice — use Receive payment",
      "Moving money between your own accounts — use Interbranch transfer",
    ],
    note:
      "Settling a bill through here would move the money and leave the invoice "
      + "open, so the balance would never come down.",
  },
};

export function VoucherHelp({ kind }: { kind: "cash" | "bank" | "journal" }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const c = CONTENT[kind];

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <>
      <button type="button" className="ghost tiny helplink" onClick={() => setOpen(true)}>
        <CircleHelp size={14} aria-hidden="true" /> {c.title}
      </button>

      <dialog
        ref={ref}
        className="confirm"
        onCancel={(e) => { e.preventDefault(); setOpen(false); }}
        onClick={(e) => { if (e.target === ref.current) setOpen(false); }}
      >
        <div className="confirm-panel helppanel">
          <div className="card-head" style={{ margin: "-1px -1px 0", borderRadius: 0 }}>
            <h2>{c.title}</h2>
            <button type="button" className="ghost tiny" aria-label="Close"
                    onClick={() => setOpen(false)}>
              <X size={14} aria-hidden="true" />
            </button>
          </div>

          <div className="card-body" style={{ textAlign: "left" }}>
            <p className="eyebrow" style={{ marginBottom: "0.35rem" }}>Use it for</p>
            <ul className="helplist ok">
              {c.use.map((t) => <li key={t}>{t}</li>)}
            </ul>

            <p className="eyebrow" style={{ margin: "1rem 0 0.35rem" }}>Not for</p>
            <ul className="helplist bad">
              {c.not.map((t) => <li key={t}>{t}</li>)}
            </ul>

            <p className="hint" style={{ marginTop: "1rem" }}>{c.note}</p>
          </div>

          <div className="actions" style={{ padding: "0 1rem 1rem" }}>
            <button type="button" onClick={() => setOpen(false)}>Got it</button>
          </div>
        </div>
      </dialog>
    </>
  );
}
