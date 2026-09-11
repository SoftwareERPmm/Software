"use client";

import { useEffect, useRef, useState } from "react";
import { useActionState } from "react";
import { Pencil, TriangleAlert, ArrowRight } from "lucide-react";
import { money, qty } from "@/lib/format";
import type { ActionResult } from "@/lib/actions";

export type CorrectableLine = {
  /**
   * The stored line this row edits. Sent back with the edit so the correction
   * changes that line rather than rebuilding one from the item and the price —
   * everything else the line carries (a discount, a free-goods reason, which
   * receipt line it bills) has to survive being corrected, and can only do so
   * if the correction knows which line it is looking at.
   */
  lineId: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  uomCode: string | null;
  ordered: number;
  /** Already received or delivered. The floor the quantity cannot go under. */
  fulfilled: number;
  unitPrice: number;
  /**
   * Quantity fixed, price open. Set on an invoice line that bills a receipt
   * or a delivery: those goods moved, and a correction is about what was
   * agreed for them, never about how many there were.
   */
  lockQty?: boolean;
};

/** One document a correction would touch, as the confirmation shows it. */
type Affected = {
  id: string;
  docNo: string;
  docType: string;
  version: number;
  totalBefore: number;
  totalAfter: number;
  blocked: string | null;
};

type Plan = { order: Affected; affected: Affected[] };
type PreviewState = { error: string } | { ok: true; plan: Plan; fingerprint: string };
/** The confirmation either posts, refuses, or hands back a changed plan. */
type ConfirmState =
  | ActionResult
  | { stale: true; plan: Plan; fingerprint: string };

const TYPE_WORD: Record<string, string> = {
  SALES_INVOICE: "Sales invoice",
  PURCHASE_INVOICE: "Purchase invoice",
  SALES_ORDER: "Sales order",
  PURCHASE_ORDER: "Purchase order",
};

/**
 * Correct the order, and let what was built on it follow.
 *
 * The tester's rule, given a screen: an order-based transaction is edited
 * through the order, never by opening the invoice underneath it and typing a
 * different number. So this is the only place the agreed price changes, and
 * the invoices that inherited it change with it.
 *
 * Deliberately three steps rather than one. Correcting an order that has
 * already been invoiced re-posts documents the customer has seen and moves
 * the money in the accounts, and nobody should discover that from the result.
 * So: say what it should have been, see exactly which documents that touches
 * and what each becomes, then confirm. The middle step is not decoration — it
 * is where a blocked invoice surfaces, before anything has moved rather than
 * as a failure afterwards.
 *
 * Quantities may only go up. What has arrived, arrived: an order cut below
 * what was received leaves goods on the shelf answering a line that no longer
 * holds them, so the floor is enforced here in the form and again in the
 * engine, which is the one that counts.
 */
export function CorrectOrder({
  preview, confirm, documentId, docNo, version, sales, lines, noun = "order",
}: {
  preview: (prev: unknown, fd: FormData) => Promise<PreviewState>;
  confirm: (prev: unknown, fd: FormData) => Promise<ConfirmState>;
  documentId: string;
  docNo: string;
  version: number;
  sales: boolean;
  lines: CorrectableLine[];
  /** What this document is called in the sentences below. */
  noun?: "order" | "invoice";
}) {
  const [previewState, previewAction, previewing] =
    useActionState<PreviewState | null, FormData>(preview as never, null);
  const [confirmState, confirmAction, confirming] =
    useActionState<ConfirmState | null, FormData>(confirm as never, null);

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"edit" | "review">("edit");
  const [reason, setReason] = useState("");
  const [draft, setDraft] = useState(() =>
    lines.map((l) => ({ qty: String(l.ordered), unitPrice: String(l.unitPrice) })));

  // A plan is only ever shown for the numbers it was made from. Typing in the
  // form after previewing sends it back to the edit step, so nobody confirms
  // a consequence calculated from figures they have since changed.
  useEffect(() => {
    if (previewState && "ok" in previewState) setStep("review");
  }, [previewState]);

  // And the confirmation can come back saying the world moved — somebody paid
  // one of these invoices, or shipped the rest of the order, between the
  // preview being drawn and the button being pressed. Nothing is posted in
  // that case; the revised plan is shown instead, and the reader decides
  // again knowing what it says now.
  useEffect(() => {
    if (confirmState && "stale" in confirmState) setStep("review");
  }, [confirmState]);

  if (lines.length === 0) return null;

  const payload = lines.map((l, i) => ({
    lineId: l.lineId,
    itemId: l.itemId,
    qty: Number(draft[i]?.qty ?? l.ordered),
    unitPrice: Number(draft[i]?.unitPrice ?? l.unitPrice),
  }));

  const edited = payload.some((p, i) =>
    Math.abs(p.qty - lines[i].ordered) > 0.0001
    || Math.abs(p.unitPrice - lines[i].unitPrice) > 0.0001);
  const belowFulfilled = payload.some((p, i) => p.qty + 0.0001 < lines[i].fulfilled);
  const totalNow = lines.reduce((t, l) => t + l.ordered * l.unitPrice, 0);
  const totalAfter = payload.reduce((t, p) => t + p.qty * p.unitPrice, 0);

  const change = (i: number, field: "qty" | "unitPrice", value: string) => {
    setStep("edit");
    setDraft((d) => d.map((row, j) => (j === i ? { ...row, [field]: value } : row)));
  };

  // The revised plan wins when the confirmation returned one: it is the newer
  // account of the same question.
  const stale = confirmState && "stale" in confirmState ? confirmState : null;
  const plan = stale
    ? stale.plan
    : previewState && "ok" in previewState ? previewState.plan : null;
  const fingerprint = stale
    ? stale.fingerprint
    : previewState && "ok" in previewState ? previewState.fingerprint : "";
  const blockers = plan
    ? [plan.order, ...plan.affected].filter((a) => a.blocked)
    : [];

  const close = () => { setOpen(false); setStep("edit"); };

  return (
    <>
      <button type="button" className="btn ghost" onClick={() => setOpen(true)}>
        <Pencil size={14} aria-hidden="true" /> Correct {noun}
      </button>

      <Dialog open={open} onClose={close}>
        <div className="card-head">
          <h2>Correct {docNo}</h2>
          <span className="page-sub">
            {step === "edit"
              ? `What the ${noun} should have said. It keeps its number and becomes
                 v${version + 1}; v${version} stays readable.`
              : "What confirming would do. Nothing has changed yet."}
          </span>
        </div>

        {previewState && "error" in previewState && (
          <div className="alert">{previewState.error}</div>
        )}
        {confirmState && "error" in confirmState && (
          <div className="alert">{confirmState.error}</div>
        )}
        {stale && (
          <div className="alert">
            <TriangleAlert size={14} aria-hidden="true" />{" "}
            This changed while you were looking at it — nothing has been posted.
            What it would do now is below.
          </div>
        )}

        {step === "edit" ? (
          <>
            <div className="tablewrap">
              <table className="linetable">
                <thead>
                  <tr>
                    <th>Item</th>
                    {noun === "order" && (
                      <th className="r">{sales ? "Delivered" : "Received"}</th>
                    )}
                    <th className="r">Quantity</th>
                    <th className="r">Unit price</th>
                    <th className="r">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => {
                    const q = Number(draft[i]?.qty ?? l.ordered);
                    const p = Number(draft[i]?.unitPrice ?? l.unitPrice);
                    const low = q + 0.0001 < l.fulfilled;
                    return (
                      <tr key={l.itemId + i}>
                        <td className="wrap">
                          <span className="code">{l.itemCode}</span> · {l.itemName}
                        </td>
                        {noun === "order" && (
                          <td className="r">
                            {l.fulfilled > 0 ? qty(String(l.fulfilled)) : "—"}
                          </td>
                        )}
                        <td className="narrow">
                          <input
                            type="number" min={l.fulfilled || 0} step="any"
                            value={draft[i]?.qty ?? ""}
                            aria-label={`Quantity of ${l.itemCode}`}
                            aria-invalid={low || undefined}
                            readOnly={l.lockQty}
                            title={l.lockQty
                              ? "The goods this bills already moved — only the price is corrected here"
                              : undefined}
                            style={l.lockQty
                              ? { background: "var(--line-soft)", cursor: "not-allowed" }
                              : undefined}
                            onChange={(e) => change(i, "qty", e.target.value)}
                          />
                        </td>
                        <td className="narrow">
                          <input
                            type="number" min="0" step="any"
                            value={draft[i]?.unitPrice ?? ""}
                            aria-label={`Unit price of ${l.itemCode}`}
                            onChange={(e) => change(i, "unitPrice", e.target.value)}
                          />
                        </td>
                        <td className="r">{money(q * p)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {belowFulfilled && (
              <div className="alert">
                <TriangleAlert size={14} aria-hidden="true" />{" "}
                A quantity is below what has already {sales ? "gone out" : "arrived"}.
                Those goods have moved and are in the books; correcting the order
                below them would leave them answering nothing. Return them first,
                or correct to at least that much.
              </div>
            )}

            <div className="card-body">
              <div className="field">
                <label htmlFor="correct_reason">Why</label>
                <input
                  id="correct_reason" type="text" required value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={sales
                    ? "e.g. agreed price with the customer was 1,200"
                    : "e.g. supplier confirmed 1,300 a box, not 1,000"}
                />
                <span className="hint">
                  Kept on both versions, with who made the correction and when.
                </span>
              </div>
            </div>

            <form action={previewAction} className="actions">
              <input type="hidden" name="document_id" value={documentId} />
              <input type="hidden" name="lines" value={JSON.stringify(payload)} />
              <button type="submit" disabled={previewing || !edited || belowFulfilled}>
                {previewing ? "Checking…" : "Preview the change"}
              </button>
              <button type="button" className="ghost" onClick={close}>Cancel</button>
              {!edited && <span className="hint">Nothing has been changed yet.</span>}
            </form>
          </>
        ) : (
          <>
            <div className="tablewrap">
              <table className="linetable">
                <thead>
                  <tr>
                    <th>Document</th>
                    <th className="r">Now</th>
                    <th />
                    <th className="r">Becomes</th>
                    <th>Version</th>
                  </tr>
                </thead>
                <tbody>
                  {plan && [plan.order, ...plan.affected].map((a) => (
                    <tr key={a.id} className={a.blocked ? "cx-blocked" : undefined}>
                      <td className="wrap">
                        <strong>{a.docNo}</strong>
                        <span className="page-sub"> {TYPE_WORD[a.docType] ?? a.docType}</span>
                        {a.blocked && <div className="cx-why">{a.blocked}</div>}
                      </td>
                      <td className="r">{money(a.totalBefore)}</td>
                      <td className="cx-arrow">
                        <ArrowRight size={13} aria-hidden="true" />
                      </td>
                      <td className="r">
                        <strong>{money(a.totalAfter)}</strong>
                      </td>
                      <td>v{a.version} → v{a.version + 1}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="card-body">
              {blockers.length > 0 ? (
                <div className="alert">
                  <TriangleAlert size={14} aria-hidden="true" />{" "}
                  {blockers.length === 1
                    ? `${blockers[0].docNo} cannot be corrected, so none of this can be applied.`
                    : `${blockers.length} of these cannot be corrected, so none of this
                       can be applied.`}{" "}
                  A correction is all of it or none of it — half of it applied would
                  leave the order saying one price and the bill another.
                </div>
              ) : (
                <p className="page-sub" style={{ margin: 0 }}>
                  {plan && plan.affected.length === 0
                    ? noun === "invoice"
                      ? "Only this invoice changes. What it bills, and the goods behind it, stay as they are."
                      : "Nothing has been billed against this order yet, so only the order changes."
                    : `Each document keeps its number and gains a version. The quantities
                       and costs of goods already ${sales ? "delivered" : "received"} do not
                       move — only what was agreed for them.`}
                </p>
              )}
              <p className="page-sub" style={{ marginBottom: 0 }}>
                Reason: <strong>{reason || "—"}</strong>
              </p>
            </div>

            <form action={confirmAction} className="actions">
              <input type="hidden" name="document_id" value={documentId} />
              <input type="hidden" name="lines" value={JSON.stringify(payload)} />
              <input type="hidden" name="reason" value={reason} />
              {/* What was shown, sent back so the server can tell whether it
                  is still true before acting on it. */}
              <input type="hidden" name="fingerprint" value={fingerprint} />
              <button type="submit" disabled={confirming || blockers.length > 0 || !reason.trim()}>
                {confirming
                  ? "Correcting…"
                  : `Confirm — ${money(totalNow)} becomes ${money(totalAfter)}`}
              </button>
              <button type="button" className="ghost" onClick={() => setStep("edit")}>
                Back
              </button>
            </form>
          </>
        )}
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
