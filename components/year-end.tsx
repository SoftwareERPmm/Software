"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { ActionResult } from "@/lib/actions";

// `+ 0` so a negated zero prints "0" rather than "-0".
const money = (v: string | number | null | undefined) =>
  (Number(v ?? 0) + 0).toLocaleString("en-US", { maximumFractionDigits: 0 });

const day = (v: string) =>
  new Date(v).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

type Year = {
  fiscal_year_id: string; code: string; status: string;
  start_date: string; end_date: string;
  open_periods: string; periods: string;
  revenue_balance: string; cost_balance: string; result: string;
  closed_by_document_id: string | null; close_doc_no: string | null;
  closed_result: string | null; closed_on: string | null;
};

/**
 * Closing a year, and undoing it.
 *
 * Deliberately shows the figure before asking. A close is one press that
 * moves a year's entire result into equity and shuts twelve periods, and the
 * person doing it should see the number they are about to make permanent —
 * not a confirmation dialogue about an amount they have to go and look up.
 */
export function YearEnd({
  years, closeAction, reopenAction,
}: {
  years: Year[];
  closeAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  reopenAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
}) {
  const [closeState, closeFormAction, closing] =
    useActionState<ActionResult | null, FormData>(closeAction as never, null);
  const [reopenState, reopenFormAction] =
    useActionState<ActionResult | null, FormData>(reopenAction as never, null);

  const [confirming, setConfirming] = useState<string | null>(null);
  const [reopening, setReopening] = useState<string | null>(null);
  const [attemptKey] = useState(() => crypto.randomUUID());

  const router = useRouter();
  useEffect(() => {
    if (reopenState && "ok" in reopenState) { setReopening(null); router.refresh(); }
  }, [reopenState, router]);

  const error = [closeState, reopenState]
    .find((s) => s && "error" in s) as { error: string } | undefined;

  return (
    <>
      {error && <div className="alert">{error.error}</div>}

      {years.map((y) => {
        const closed = y.status === "CLOSED";
        // A closed year's live balances are all zero by construction, so the
        // figure comes off the closing document instead.
        const result = closed && y.closed_result !== null
          ? Number(y.closed_result)
          : Number(y.result);
        return (
          <section key={y.fiscal_year_id}>
            <div className="card">
              <div className="card-head">
                <h2>{y.code}</h2>
                <span className="page-sub">
                  {day(y.start_date)} – {day(y.end_date)} ·{" "}
                  {closed
                    ? <>closed{y.close_doc_no && <> by {y.close_doc_no}</>}</>
                    : <>{y.open_periods} of {y.periods} periods open</>}
                </span>
              </div>

              <div className="card-body">
                <div className="row">
                  {!closed && (
                    <>
                      <div className="field">
                        <label>Revenue</label>
                        <span className="fixedfield">{money(-Number(y.revenue_balance))}</span>
                      </div>
                      <div className="field">
                        <label>Cost and expense</label>
                        <span className="fixedfield">{money(y.cost_balance)}</span>
                      </div>
                    </>
                  )}
                  <div className="field">
                    <label>{result >= 0 ? "Profit" : "Loss"} for the year</label>
                    <span className="fixedfield" style={{
                      color: result >= 0 ? undefined : "var(--bad)",
                    }}>
                      {money(Math.abs(result))}
                    </span>
                    <span className="hint">
                      {closed
                        ? <>In retained earnings since {y.closed_on ? day(y.closed_on) : "the close"}</>
                        : <>Goes to retained earnings when the year closes</>}
                    </span>
                  </div>
                </div>

                <div className="actions" style={{ marginTop: "0.75rem" }}>
                  {!closed && confirming !== y.fiscal_year_id && (
                    <>
                      <button type="button" disabled={result === 0 && Number(y.cost_balance) === 0}
                              onClick={() => setConfirming(y.fiscal_year_id)}>
                        Close {y.code}
                      </button>
                      <span className="page-sub">
                        Empties the profit and loss accounts into retained earnings and
                        shuts every period in the year.
                      </span>
                    </>
                  )}

                  {!closed && confirming === y.fiscal_year_id && (
                    <form action={closeFormAction} className="form">
                      <input type="hidden" name="fiscal_year_id" value={y.fiscal_year_id} />
                      <input type="hidden" name="idempotency_key" value={attemptKey} />
                      <div className="hintbar caution">
                        <strong>
                          {money(Math.abs(result))} {result >= 0 ? "profit" : "loss"} moves
                          into retained earnings
                        </strong>{" "}
                        and all {y.periods} periods of {y.code} shut. Nothing dated inside
                        the year can be posted afterwards — not a late invoice, not a
                        correction. Reopening is possible and leaves a reversal on file.
                      </div>
                      <div className="field" style={{ marginTop: "0.6rem" }}>
                        <label htmlFor={`memo-${y.fiscal_year_id}`}>Note</label>
                        <input id={`memo-${y.fiscal_year_id}`} name="memo" type="text"
                               placeholder={`Closing ${y.code}`} />
                      </div>
                      <div className="actions">
                        <button type="submit" disabled={closing}>
                          {closing ? "Closing…" : `Yes, close ${y.code}`}
                        </button>
                        <button type="button" className="ghost"
                                onClick={() => setConfirming(null)}>Cancel</button>
                      </div>
                    </form>
                  )}

                  {closed && reopening !== y.fiscal_year_id && (
                    <>
                      {y.closed_by_document_id && (
                        <Link href={`/documents/${y.closed_by_document_id}`} className="btn ghost">
                          View the closing entry
                        </Link>
                      )}
                      <button type="button" className="ghost"
                              onClick={() => setReopening(y.fiscal_year_id)}>
                        Reopen {y.code}
                      </button>
                    </>
                  )}

                  {closed && reopening === y.fiscal_year_id && (
                    <form action={reopenFormAction} className="form">
                      <input type="hidden" name="fiscal_year_id" value={y.fiscal_year_id} />
                      <div className="hintbar caution">
                        Reopening voids the closing entry and puts the year&rsquo;s result
                        back into the profit and loss accounts. The original stays on
                        file with the reversal beside it, so the reopening is readable
                        afterwards.
                      </div>
                      <div className="field" style={{ marginTop: "0.6rem" }}>
                        <label htmlFor={`why-${y.fiscal_year_id}`}>Why</label>
                        <input id={`why-${y.fiscal_year_id}`} name="reason" type="text" required
                               placeholder="Auditor found an unrecorded invoice" />
                      </div>
                      <div className="actions">
                        <button type="submit">Reopen {y.code}</button>
                        <button type="button" className="ghost"
                                onClick={() => setReopening(null)}>Cancel</button>
                      </div>
                    </form>
                  )}
                </div>
              </div>
            </div>
          </section>
        );
      })}
    </>
  );
}
