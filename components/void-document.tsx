"use client";

import { useActionState, useState } from "react";
import { Lock, FileX, Undo2 } from "lucide-react";
import type { ActionResult } from "@/lib/actions";

type Blocker = { reason: string; docNo?: string; docId?: string };

/**
 * The void control on a posted document.
 *
 * Deliberately not a bare Delete button. Voiding posts a reversing entry and
 * cannot be undone by pressing it again, so the dialog says what will happen
 * in the same words the engine will act in — the effects listed here come
 * from the same analysis the engine re-runs before it writes anything.
 *
 * When something is built on top of the document, the button is not offered
 * at all and the blockers are shown instead, each naming the document in the
 * way. "Void PI-000004 first" is an instruction; a greyed-out button is a
 * puzzle.
 *
 * But it says so on request rather than permanently. A red panel explaining
 * why you cannot do a thing you never asked to do sat on every settled
 * invoice in the system, shouting a prohibition at somebody reading their own
 * books — and by being red and always there it taught people to read past
 * exactly the colour that should stop them. Now it is a quiet line that opens
 * when pressed.
 */
export function VoidDocument({
  action, documentId, docNo, canVoid, blockers, effects, children,
  returnHref, returnLabel, restoresUnits, salesReturnHref,
}: {
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  documentId: string;
  docNo: string;
  canVoid: boolean;
  blockers: Blocker[];
  effects: string[];
  /**
   * The other thing you can do to a posted document: correct it. Rendered in
   * the same row rather than a second one of its own, because two lone
   * buttons stacked read as two unrelated sections when they are the same
   * question — this is wrong, what now?
   */
  children?: React.ReactNode;
  /**
   * Where a supplier return for this receipt would be started, pre-filled.
   *
   * Set only on a goods receipt, and it changes what voiding asks. Voiding
   * says the receipt should never have existed; a return says the goods came
   * and went back. Both take the stock off the shelf and they leave entirely
   * different records — one showing nothing ever arrived, the other showing
   * what arrived, when it left and what the supplier owes for it. The screen
   * asked neither, took any free-text reason, and let somebody undoing a real
   * physical return erase the fact it happened.
   */
  returnHref?: string | null;
  /**
   * How many units this void would put back on the shelf, when it would put
   * any back at all — a counter sale, which took the stock out as part of
   * itself. Nothing restores stock without somebody saying it is there, so
   * this turns the confirmation on rather than deciding anything by itself.
   */
  restoresUnits?: number | null;
  /** Where the sales return lives, for when the customer still has the goods. */
  salesReturnHref?: string | null;
  /** What that return will actually do — it differs once a bill exists. */
  returnLabel?: string | null;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    action as never, null
  );

  /** One void per opening of this panel — see postOnce. */
  const [attemptKey] = useState(() => crypto.randomUUID());
  const [open, setOpen] = useState(false);
  /** null until the goods question is answered; false = never arrived. */
  const [arrived, setArrived] = useState<boolean | null>(null);

  if (!canVoid) {
    return (
      <div className="docactions voidlock">
        {children}
        <button type="button" className="btn ghost tiny" onClick={() => setOpen(!open)}
                aria-expanded={open}>
          <Lock size={13} aria-hidden="true" /> Cannot be voided
        </button>
        {open && (
          <div className="voidlock-why">
            <strong>Something is built on this document.</strong>
            <ul>
              {blockers.map((b, i) => (
                <li key={i}>
                  {b.docId ? (
                    <>
                      <a href={`/documents/${b.docId}`} style={{ color: "var(--brand)" }}>{b.docNo}</a>
                      {b.reason.replace(b.docNo ?? "", "")}
                    </>
                  ) : b.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  if (!open) {
    return (
      <div className="docactions">
        {children}
        <button type="button" className="warn"
                onClick={() => { setArrived(null); setOpen(true); }}>
          {returnHref ? "Cancel this receipt" : "Void this document"}
        </button>
      </div>
    );
  }

  /**
   * Which of the two situations this is. Unanswered until it is answered:
   * defaulting to "never arrived" would make the commoner, safer-looking
   * option the one nobody reads.
   */
  /**
   * The same question the receipt asks, from the other end of the warehouse.
   *
   * Voiding a counter sale puts stock back, and the system cannot see a
   * shelf. Keyed in error with the goods still on the counter is one thing;
   * voided after the customer carried them out is another, and restoring the
   * stock then makes the books claim something that is not there.
   *
   * The second answer is not a void at all. If the customer has the goods the
   * sale happened, and what records them coming back — with the credit that
   * belongs to it — is a return.
   */
  if (restoresUnits && restoresUnits > 0 && arrived === null) {
    return (
      <div className="card" style={{ marginTop: "0.75rem" }}>
        <div className="card-head">
          <h2>Void {docNo}</h2>
          <span className="actions">
            <button type="button" className="ghost tiny" onClick={() => setOpen(false)}>Cancel</button>
          </span>
        </div>
        <div className="card-body">
          <p className="page-sub" style={{ marginBottom: "0.9rem" }}>
            This sale took {restoresUnits} unit{restoresUnits === 1 ? "" : "s"} out of
            the warehouse. Where are they now?
          </p>
          <div className="modes">
            <button type="button" className="mode" onClick={() => setArrived(true)}>
              <span className="mode-icon"><FileX size={18} aria-hidden="true" /></span>
              <span className="mode-text">
                <strong>Back on the shelf</strong>
                <span className="mode-lead">Keyed in error — the goods never left.</span>
                <span className="mode-note">
                  Voids the sale and puts the {restoresUnits} back
                </span>
              </span>
            </button>
            <a className="mode" href={salesReturnHref ?? "/sales/returns/new"}>
              <span className="mode-icon"><Undo2 size={18} aria-hidden="true" /></span>
              <span className="mode-text">
                <strong>The customer has them</strong>
                <span className="mode-lead">The sale happened. They are bringing them back.</span>
                <span className="mode-note">
                  Records a customer return, with the credit that goes with it
                </span>
              </span>
            </a>
          </div>
        </div>
      </div>
    );
  }

  if (returnHref && arrived === null) {
    return (
      <div className="card" style={{ marginTop: "0.75rem" }}>
        <div className="card-head">
          <h2>Cancel {docNo}</h2>
          <span className="actions">
            <button type="button" className="ghost tiny" onClick={() => setOpen(false)}>Cancel</button>
          </span>
        </div>
        <div className="card-body">
          <p className="page-sub" style={{ marginBottom: "0.9rem" }}>
            Did these goods physically arrive at the warehouse?
          </p>
          <div className="modes">
            <button type="button" className="mode" onClick={() => setArrived(false)}>
              <span className="mode-icon"><FileX size={18} aria-hidden="true" /></span>
              <span className="mode-text">
                <strong>No — the receipt is a mistake</strong>
                <span className="mode-lead">Entered twice, or keyed against the wrong order.</span>
                <span className="mode-note">Voids it. Nothing physically moved.</span>
              </span>
            </button>
            <a className="mode" href={returnHref}>
              <span className="mode-icon"><Undo2 size={18} aria-hidden="true" /></span>
              <span className="mode-text">
                <strong>Yes — and they went back to the supplier</strong>
                <span className="mode-lead">They were on the shelf and have been sent back.</span>
                <span className="mode-note">
                  {returnLabel ?? "Records a supplier return, filled in from this receipt"}
                </span>
              </span>
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="card" style={{ marginTop: "0.75rem" }}>
      <div className="card-head">
        <h2>Void {docNo}?</h2>
        <span className="actions">
          <button type="button" className="ghost tiny" onClick={() => setOpen(false)}>Cancel</button>
        </span>
      </div>
      <div className="card-body">
        {state && "error" in state && <div className="alert">{state.error}</div>}

        <ul style={{ margin: "0 0 0.75rem", paddingLeft: "1.1rem", color: "var(--muted)" }}>
          {effects.map((e, i) => <li key={i}>{e}</li>)}
        </ul>

        <form action={formAction} className="form">
          <input type="hidden" name="id" value={documentId} />
          <input type="hidden" name="idempotency_key" value={attemptKey} />
          {/* Reaching this step in the sales flow means somebody answered
              "back on the shelf". The engine refuses to restore stock without
              it, so this is the answer travelling rather than a default. */}
          {restoresUnits && restoresUnits > 0 && arrived === true && (
            <input type="hidden" name="goods_back" value="on" />
          )}
          <div className="field">
            <label htmlFor="reason">Why</label>
            <input id="reason" name="reason" type="text" autoFocus
                   placeholder="entered twice, wrong customer…" />
            <span className="hint">
              Kept on the document and in the history log. Worth a few words —
              it is what the log will show months from now.
            </span>
          </div>
          <div className="actions">
            <button type="submit" className="warn" disabled={pending}>
              {pending ? "Voiding…" : `Void ${docNo}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
