/**
 * Voiding a posted document, and editing one.
 *
 * Neither rewrites anything. A void posts a reversing journal entry so every
 * account it touched nets to zero; the original keeps its number, its lines
 * and its entry, and gains a link to the reversal. An edit is a void followed
 * by a fresh document that names the one it replaces. So a trial balance
 * still ties to the subledgers afterwards, and an August report printed in
 * August still says what it said.
 *
 * The reason this is not simply "set a deleted flag" is concrete rather than
 * doctrinal. v_trial_balance reads journal_line and applies no document
 * filter; v_open_item reads document and selects status = 'POSTED'. Hiding a
 * document without a reversing entry therefore drops a receivable out of the
 * aging while AR control still carries it — the two reports disagree and
 * neither looks broken. That is the hole migration 0023 closed, and 0037
 * keeps it closed by permitting the move to REVERSED only when the reversal
 * is supplied with it.
 *
 * What blocks a void is the other half. A document with something built on
 * top of it cannot be undone underneath it: an invoice that has been paid, a
 * receipt that has been billed, stock that has since been sold. Those are
 * reported as blockers, naming the document in the way, so the answer is
 * "void that first" rather than a constraint violation.
 */

import type { TransactionSql } from "postgres";
import { sql } from "./db";

/**
 * The pool or an open transaction — this only ever queries, and postgres.js
 * gives the two different types that do not union cleanly at the call site.
 * The same cast posting.ts uses for the same reason.
 */
type Db = TransactionSql;

export type VoidBlocker = {
  reason: string;
  /** The document standing in the way, when there is one to name. */
  docNo?: string;
  docId?: string;
};

export type VoidPlan = {
  documentId: string;
  docNo: string;
  docType: string;
  /** False when anything below would have to be undone first. */
  canVoid: boolean;
  blockers: VoidBlocker[];
  /** Plain sentences describing what voiding would do, for the confirm step. */
  effects: string[];
  /** The date the reversal would post on — the original's, or today when
   *  that period has since been closed. */
  reversalDate: string;
};

const money = (v: unknown) =>
  Number(v ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 });

/**
 * What voiding this document would do, and what stands in the way.
 *
 * Read-only, and deliberately the same code the void itself runs first: a
 * confirmation screen that predicts one thing while the action does another
 * is worse than no confirmation.
 */
export async function planVoid(documentId: string): Promise<VoidPlan | null> {
  return planVoidIn(sql as unknown as TransactionSql, documentId);
}

/**
 * The same analysis against an open transaction.
 *
 * voidDocument re-runs it after taking its lock, so a document that became
 * un-voidable between the confirmation screen and the button — someone else
 * billing the receipt, say — is caught rather than half-undone.
 */
export async function planVoidIn(db: Db, documentId: string): Promise<VoidPlan> {
  const [doc] = await db`
    select d.id, d.company_id, d.doc_no, d.doc_type, d.status, d.gross_total,
           d.partner_id, d.journal_entry_id, d.reversed_by_document_id,
           to_char(d.doc_date, 'YYYY-MM-DD') as doc_date,
           to_char(d.posting_date, 'YYYY-MM-DD') as posting_date
      from document d where d.id = ${documentId}`;
  if (!doc) throw new Error("That document no longer exists");

  const blockers: VoidBlocker[] = [];
  const effects: string[] = [];

  if (doc.status === "DRAFT") {
    blockers.push({ reason: "This is a draft. It posts nothing, so delete it outright rather than voiding it." });
  } else if (doc.status === "REVERSED" || doc.reversed_by_document_id) {
    blockers.push({ reason: "This document has already been voided." });
  } else if (doc.status !== "POSTED") {
    blockers.push({ reason: `A ${doc.status.toLowerCase()} document cannot be voided.` });
  }

  // ---- what has been built on top of it -----------------------------------
  // Anything naming this document as its source is downstream of it, and
  // undoing this one underneath it would leave that one explaining nothing.
  const children = await db`
    select id, doc_no, doc_type from document
     where company_id = ${doc.company_id}
       and source_document_id = ${documentId}
       and status = 'POSTED'`;
  for (const c of children as unknown as { id: string; doc_no: string; doc_type: string }[]) {
    blockers.push({
      reason: `${c.doc_no} was raised from this document. Void that first.`,
      docNo: c.doc_no, docId: c.id,
    });
  }

  // A document this one was raised from is fine to leave alone — voiding a
  // purchase invoice does not disturb the receipt it billed, it only reopens
  // the GR/IR balance the receipt is still holding.

  // ---- money already settled against it ------------------------------------
  const allocations = await db`
    select d.id, d.doc_no, sum(pa.amount) as amount
      from payment_allocation pa
      join document d on d.id = pa.payment_id
     where pa.invoice_id = ${documentId} and d.status = 'POSTED'
     group by d.id, d.doc_no`;
  for (const a of allocations as unknown as { id: string; doc_no: string; amount: string }[]) {
    blockers.push({
      reason: `${a.doc_no} has settled ${money(a.amount)} against this. Void the payment first.`,
      docNo: a.doc_no, docId: a.id,
    });
  }

  // ---- stock this document put on the shelf, since consumed ----------------
  // A receipt whose goods have been sold cannot be taken back: the layers it
  // created are partly gone, and the cost of the sale that took them was
  // computed from this receipt's price.
  const consumed = await db`
    select coalesce(sum(c.qty), 0) as qty
      from stock_lot l
      join stock_movement sm on sm.id = l.stock_movement_id
      join stock_lot_consumption c on c.lot_id = l.id
     where sm.document_id = ${documentId}`;
  const consumedQty = Number((consumed as unknown as { qty: string }[])[0]?.qty ?? 0);
  if (consumedQty > 0) {
    blockers.push({
      reason: `${consumedQty} unit${consumedQty === 1 ? "" : "s"} received on this document ` +
              `have since been issued. Void whatever took them first.`,
    });
  }

  // ---- stock this document took off the shelf ------------------------------
  // Putting it back means re-creating the layers it consumed at the cost it
  // consumed them at. That is exactly what a sales return already does, and
  // is not built here yet.
  const movements = await db`
    select count(*)::int as n, coalesce(sum(case when qty < 0 then 1 else 0 end), 0)::int as issues
      from stock_movement where document_id = ${documentId}`;
  const mv = (movements as unknown as { n: number; issues: number }[])[0];
  if (mv && mv.issues > 0) {
    blockers.push({
      reason: "This document issued stock. Putting issued stock back means re-creating the " +
              "cost layers it consumed, which is not built yet — use a return instead.",
    });
  }
  if (mv && mv.n > 0 && mv.issues === 0) {
    const remedy =
      doc.doc_type === "GOODS_RECEIPT" ? "a purchase return"
      : doc.doc_type === "STOCK_ADJUSTMENT" ? "an adjustment the other way"
      : doc.doc_type === "STOCK_TRANSFER" ? "a transfer back"
      : "a correcting stock document";
    blockers.push({
      reason: `This document received stock. Taking received stock back off the shelf is ` +
              `not built yet — use ${remedy} instead.`,
    });
  }

  // ---- where the reversal can land -----------------------------------------
  // Its own period by preference, so the month it belongs to nets to zero
  // within itself. A closed period cannot take it, and the reversal goes to
  // today instead — which is the honest answer rather than reopening a period
  // somebody has already reported on.
  const [openHere] = await db`
    select count(*)::int as n from fiscal_period
     where company_id = ${doc.company_id} and status = 'OPEN'
       and ${doc.posting_date}::date between start_date and end_date`;
  const today = new Date().toISOString().slice(0, 10);
  const reversalDate = Number(openHere.n) > 0 ? doc.posting_date : today;

  const [openToday] = await db`
    select count(*)::int as n from fiscal_period
     where company_id = ${doc.company_id} and status = 'OPEN'
       and ${today}::date between start_date and end_date`;
  if (Number(openHere.n) === 0 && Number(openToday.n) === 0) {
    blockers.push({
      reason: `${doc.posting_date} is in a closed period and today is too, so the reversal ` +
              `has nowhere to post. Open a period first.`,
    });
  }

  // ---- what it would do -----------------------------------------------------
  if (doc.journal_entry_id) {
    effects.push(`Posts a reversing entry on ${reversalDate}, so every account this document touched returns to where it was.`);
  }
  if (Number(doc.gross_total) > 0) {
    effects.push(`Removes ${money(doc.gross_total)} from wherever this document put it.`);
  }
  effects.push(`${doc.doc_no} stays in the ledger, marked voided, alongside the reversal.`);
  effects.push("The void is recorded in the document history and can be seen there afterwards.");

  return {
    documentId: doc.id,
    docNo: doc.doc_no,
    docType: doc.doc_type,
    canVoid: blockers.length === 0,
    blockers,
    effects,
    reversalDate,
  };
}
