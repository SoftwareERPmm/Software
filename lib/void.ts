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
           d.lifecycle_owner_id,
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

  // ---- goods that are not ours --------------------------------------------
  //
  // Consigned stock is the consignor's until it sells, so a delivery drawing
  // on it writes no stock movement and no journal line of its own — and
  // nothing here releases what it drew from consignment_lot_consumption. The
  // engine refused these anyway, but only at the last moment and by way of
  // "has no entry to reverse", which the plan never knew about: the screen
  // offered a Void button that failed when it was pressed.
  //
  // Refused here instead, in the words of the actual reason. This does not
  // make consignment voidable — it makes the refusal honest and early.
  const [consigned] = await db`
    select count(*)::int as n from document_line
     where document_id = ${documentId} and is_consignment`;
  if (doc.doc_type === "CONSIGNMENT_RECEIPT" || Number(consigned.n) > 0) {
    blockers.push({
      reason: doc.doc_type === "CONSIGNMENT_RECEIPT"
        ? "These are the consignor's goods, held rather than bought, so there is "
          + "no purchase to reverse. Undoing a consignment receipt is not built yet."
        : "This document moved consigned goods, which belong to the consignor "
          + "until they sell. Releasing them again is not built yet — the "
          + "consignor's stock would stay drawn down against a document that no "
          + "longer exists.",
    });
  }

  // ---- nothing to reverse --------------------------------------------------
  // A void is a mirror-image journal entry, so a document that posted none
  // has nothing to mirror. The engine has always refused these; the plan
  // said they could go, which is how a refusal arrived after the button.
  if (doc.status === "POSTED") {
    const [entry] = await db`
      select count(*)::int as n from journal_line
       where journal_entry_id = ${doc.journal_entry_id}`;
    if (Number(entry.n) === 0) {
      blockers.push({
        reason: `${doc.doc_no} posted nothing to the ledger, so there is no entry `
          + `to reverse. Nothing about it can be undone by voiding.`,
      });
    }
  }

  // ---- what has been built on top of it -----------------------------------
  // Anything naming this document as its source is downstream of it, and
  // undoing this one underneath it would leave that one explaining nothing.
  // Documents this one composed are excluded: they are not somebody else's
  // work resting on this, they are part of it, and the void carries them
  // rather than demanding they be unpicked first. A counter sale's delivery
  // and the receipt for the cash taken with it are the cases — neither was
  // asked for, and requiring somebody to void a receipt they never created
  // is how a cash counter sale became impossible to undo.
  //
  // Their own rules still hold. What each owned document refuses, the whole
  // void refuses, gathered below — so goods already sold on still stop this,
  // exactly as they stop it today.
  const children = await db`
    select id, doc_no, doc_type from document
     where company_id = ${doc.company_id}
       and source_document_id = ${documentId}
       and status = 'POSTED'
       and (lifecycle_owner_id is null or lifecycle_owner_id <> ${documentId})
       -- Nor this document's own owner. A counter sale's invoice names the
       -- delivery as its source, and the delivery names the invoice as its
       -- owner: they point at each other, because one act wrote both. Read
       -- from the delivery, the invoice is not something built on top of it
       -- to be unpicked first — it is the thing this belongs to, and it is
       -- being undone in the same breath.
       and (${doc.lifecycle_owner_id ?? null}::uuid is null
            or id <> ${doc.lifecycle_owner_id ?? null}::uuid)`;
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
  // Money somebody paid against this blocks it; money this document took for
  // itself does not. The cash on a counter sale is the invoice's own — it
  // comes back when the invoice goes, and asking for it to be undone first
  // is asking about a document nobody wrote.
  const allocations = await db`
    select d.id, d.doc_no, sum(pa.amount) as amount
      from payment_allocation pa
      join document d on d.id = pa.payment_id
     where pa.invoice_id = ${documentId} and d.status = 'POSTED'
       and (d.lifecycle_owner_id is null or d.lifecycle_owner_id <> ${documentId})
     group by d.id, d.doc_no`;
  for (const a of allocations as unknown as { id: string; doc_no: string; amount: string }[]) {
    blockers.push({
      reason: `${a.doc_no} has settled ${money(a.amount)} against this. Void the payment first.`,
      docNo: a.doc_no, docId: a.id,
    });
  }

  // ---- advances this payment has already been spent on ---------------------
  // Voiding the receipt would stop its allocations counting, so the invoices
  // would reopen — but the applications' own entries would still stand, with
  // receivables credited for money no longer there. Voiding one document must
  // not quietly void another, so the applications come off first, by hand and
  // in sight.
  const spent = await db`
    select app.id, app.doc_no, sum(pa.amount) as amount
      from payment_allocation pa
      join document app on app.id = pa.applied_by_document_id
     where pa.payment_id = ${documentId} and app.status = 'POSTED'
     group by app.id, app.doc_no
     order by app.doc_no`;
  for (const a of spent as unknown as { id: string; doc_no: string; amount: string }[]) {
    blockers.push({
      reason: `${a.doc_no} applied ${money(a.amount)} of this to an invoice. `
            + `Void that application first.`,
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

  // ---- goods this document revalued, since issued --------------------------
  // Undoing a revaluation means taking the value back off the goods it was put
  // on. That works while the goods are still there. Once some have been sold —
  // relieved at the corrected cost, into a period that may since have closed —
  // taking it back off leaves the remaining stock stating one value and the
  // ledger another, by exactly what went out at the higher figure. Correcting
  // forward is the honest move; this is the same reasoning as the receipt rule
  // above, applied to value rather than quantity.
  const revalued = await db`
    select coalesce(sum(c.qty), 0) as qty
      from stock_lot_adjustment adj
      join stock_lot_consumption c on c.lot_id = adj.lot_id
     where adj.document_id = ${documentId}
       and c.created_at > adj.created_at`;
  const revaluedQty = Number((revalued as unknown as { qty: string }[])[0]?.qty ?? 0);
  if (revaluedQty > 0) {
    blockers.push({
      reason: `${revaluedQty} unit${revaluedQty === 1 ? "" : "s"} whose cost this document ` +
              `corrected have been issued since. Correct the cost forward with another ` +
              `bill rather than undoing this one.`,
    });
  }

  // ---- stock this document took off the shelf ------------------------------
  // Putting it back means re-creating the layers it consumed at the cost it
  // consumed them at. That is exactly what a sales return already does, and
  // is not built here yet.
  // Movements that moved goods. A revaluation writes a movement carrying value
  // and no quantity (0057), and that is not what this rule is about: nothing
  // was received to return and nothing was issued whose cost layers would have
  // to be rebuilt. Counting one would have made a bill uncorrectable the
  // moment it disagreed with its receipt — which is precisely the bill most
  // likely to need correcting again.
  const movements = await db`
    select count(*)::int as n, coalesce(sum(case when qty < 0 then 1 else 0 end), 0)::int as issues
      from stock_movement where document_id = ${documentId} and qty <> 0`;
  const mv = (movements as unknown as { n: number; issues: number }[])[0];
  // An issue somebody raised still stands: goods that went out do not come
  // back because the paperwork was undone, and a return is what records them
  // coming back. An issue this document's owner composed is different — it is
  // half of one act, and undoing that act undoes both halves. The lots it
  // consumed are re-created at the cost they left at, which voidDocumentIn
  // does and a customer return already did before it.
  /**
   * An issue may be undone, but only inside the window where undoing it and
   * recomputing history give the same answer.
   *
   * Putting issued stock back means re-creating the layers it consumed, at
   * the cost and the position they had — which the engine does, and which a
   * customer return has always done. What decides whether that is honest is
   * what happened afterwards.
   *
   *   Day 1  lot A, 10 @ 1,000
   *   Day 2  this delivery takes all ten
   *   Day 3  lot B, 10 @ 1,400
   *   Day 4  something is issued — and draws B at 1,400, because A was empty
   *
   * Undo the delivery now and A is back, dated Day 1, ahead of B in the
   * queue. But Day 4 already drew from B. Had the units been there it would
   * have drawn A at 1,000, so its cost is wrong and nothing can put that
   * right without rewriting it — which is the one thing this ledger refuses.
   *
   * So the test is not "did anything consume the layers we would restore".
   * It is "has anything been issued at all since", because any later issue
   * would have chosen differently. Outside that window a return is the honest
   * record: the goods came back on a later date, and they join the queue
   * there.
   *
   * A delivery the engine composed is exempt because it is undone in the same
   * breath as the invoice that made it — no time passes, and nothing can have
   * drawn in between.
   */
  if (mv && mv.issues > 0 && !doc.lifecycle_owner_id) {
    const [later] = await db`
      select count(*)::int as n
        from stock_movement m
       where m.company_id = ${doc.company_id}
         and m.qty < 0
         and m.document_id is distinct from ${documentId}
         -- Same item and warehouse as something this document issued: a sale
         -- of a different product cannot have been affected by these units.
         and exists (
               select 1 from stock_movement mine
                where mine.document_id = ${documentId}
                  and mine.qty < 0
                  and mine.item_id = m.item_id
                  and mine.location_id = m.location_id
                  and (m.movement_date > mine.movement_date
                       or (m.movement_date = mine.movement_date
                           and m.created_at > mine.created_at))
             )`;

    if (Number(later?.n ?? 0) > 0) {
      blockers.push({
        reason:
          `Stock has been issued since ${doc.doc_no} went out, and those issues drew from `
          + `what was left after it. Putting these units back now would change what they `
          + `should have cost. Record the goods coming back with a return instead.`,
      });
    }
  }
  if (mv && mv.n > 0 && mv.issues === 0) {
    /**
     * Goods that never arrived are a different thing from goods sent back.
     *
     * A return records stock leaving the warehouse and the supplier owing a
     * credit. For a receipt entered by mistake, or the same delivery entered
     * twice, neither happened: nothing left, because nothing was ever there,
     * and the supplier owes nothing because they were never billed. Telling
     * somebody to raise a return for that asks them to record a fiction.
     *
     * So a goods receipt may be reversed — but only while every layer it
     * created is exactly as it was created. Its own layers, not enough units
     * of that item somewhere: a later purchase must not make an already-used
     * receipt reversible, and the consumption check above is per lot for that
     * reason. A transfer consumes the lot it moves, so it fails this too, as
     * it should — the goods are somewhere else now.
     *
     * Everything else keeps its refusal. And where the layers are gone, what
     * is in the way is named rather than answered with "use a return", which
     * would not explain how thirty units that never arrived came to be sold.
     */
    const reversible = doc.doc_type === "GOODS_RECEIPT";

    if (!reversible) {
      const remedy =
        doc.doc_type === "STOCK_ADJUSTMENT" ? "an adjustment the other way"
        : doc.doc_type === "STOCK_TRANSFER" ? "a transfer back"
        : "a correcting stock document";
      blockers.push({
        reason: `This document received stock. Taking received stock back off the shelf is `
              + `not built yet — use ${remedy} instead.`,
      });
    } else {
      // What has happened to this receipt's own layers since, named by the
      // documents that did it.
      const touched = await db`
        select d.doc_no, d.doc_type, sum(c.qty)::float as qty
          from stock_lot l
          join stock_movement sm on sm.id = l.stock_movement_id
          join stock_lot_consumption c on c.lot_id = l.id
          join stock_movement out on out.id = c.stock_movement_id
          join document d on d.id = out.document_id
         where sm.document_id = ${documentId}
         group by d.doc_no, d.doc_type
         order by d.doc_no`;

      for (const t of touched as unknown as
           { doc_no: string; doc_type: string; qty: number }[]) {
        blockers.push({
          reason: `${t.doc_no} took ${t.qty} of what this receipt brought in. `
                + `That has to be resolved before this receipt can be reversed — `
                + `and if the goods really did arrive and go back, a return is what `
                + `records it, not this.`,
          docNo: t.doc_no,
        });
      }

      if ((touched as unknown[]).length === 0) {
        effects.push(
          "The stock this receipt brought in comes back off the shelf, and its cost "
          + "layers close with it."
        );
      }
    }
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
