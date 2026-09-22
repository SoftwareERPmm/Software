"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { ActionResult } from "@/lib/actions";

const money = (v: string | number | null | undefined) =>
  Number(v ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 });

const day = (v: string | null) =>
  v ? new Date(v).toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) : "—";

type Line = {
  id: string; line_no: number; txn_date: string;
  description: string | null; reference: string | null;
  amount: string; balance: string | null;
  status: string; ignore_reason: string | null;
  match_id: string | null; journal_line_id: string | null; match_note: string | null;
  entry_no: string | null; entry_date: string | null;
  doc_no: string | null; doc_type: string | null; document_id: string | null;
  partner_name: string | null; ledger_memo: string | null; ledger_amount: string | null;
};

type Candidate = {
  journal_line_id: string; entry_no: string; entry_date: string;
  doc_no: string | null; doc_type: string | null; document_id: string | null;
  partner_name: string | null; memo: string | null; amount: string;
};

/**
 * The bank's list beside ours.
 *
 * Two columns rather than one merged list, because the question is not "what
 * happened" — it is "which of these two records has something the other does
 * not". A single interleaved list answers the first question and hides the
 * second.
 *
 * Selecting a statement line on the left filters the right to what could
 * plausibly answer it — same amount first, then everything else, because the
 * common case is one obvious partner and the rare case still has to be
 * reachable.
 */
export function BankReconcile({
  statement, lines, candidates,
  matchAction, unmatchAction, ignoreAction, autoMatchAction, statusAction,
}: {
  statement: {
    id: string; statement_no: string; status: string;
    account_code: string; account_name: string;
    from_date: string; to_date: string;
    opening_balance: string | null; closing_balance: string | null;
    lines: string; matched: string; ignored: string; unmatched: string;
    net_movement: string; unmatched_value: string;
  };
  lines: Line[];
  candidates: Candidate[];
  matchAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  unmatchAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  ignoreAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  autoMatchAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  statusAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
}) {
  const [matchState, matchFormAction] =
    useActionState<ActionResult | null, FormData>(matchAction as never, null);
  const [unmatchState, unmatchFormAction] =
    useActionState<ActionResult | null, FormData>(unmatchAction as never, null);
  const [ignoreState, ignoreFormAction] =
    useActionState<ActionResult | null, FormData>(ignoreAction as never, null);
  const [autoState, autoFormAction, autoRunning] =
    useActionState<ActionResult | null, FormData>(autoMatchAction as never, null);
  const [statusState, statusFormAction, closing] =
    useActionState<ActionResult | null, FormData>(statusAction as never, null);

  const [selected, setSelected] = useState<string | null>(null);
  const [ignoring, setIgnoring] = useState<string | null>(null);

  const router = useRouter();
  useEffect(() => {
    for (const st of [matchState, unmatchState, ignoreState, autoState, statusState]) {
      if (st && "ok" in st) { setSelected(null); setIgnoring(null); router.refresh(); return; }
    }
  }, [matchState, unmatchState, ignoreState, autoState, statusState, router]);

  const error = [matchState, unmatchState, ignoreState, autoState, statusState]
    .find((s) => s && "error" in s) as { error: string } | undefined;

  const open = statement.status === "OPEN";
  const unmatched = Number(statement.unmatched);
  const picked = lines.find((l) => l.id === selected) ?? null;

  /* Candidates the same amount as the selected line come first — that is
     what a match almost always is — but nothing is hidden, because the
     interesting reconciling items are the ones that do not match cleanly. */
  const ranked = picked
    ? [...candidates].sort((a, b) => {
        const exact = (c: Candidate) =>
          Math.abs(Number(c.amount) - Number(picked.amount)) < 0.0001 ? 0 : 1;
        if (exact(a) !== exact(b)) return exact(a) - exact(b);
        return new Date(a.entry_date).getTime() - new Date(b.entry_date).getTime();
      })
    : candidates;

  const exactCount = picked
    ? candidates.filter((c) =>
        Math.abs(Number(c.amount) - Number(picked.amount)) < 0.0001).length
    : 0;

  return (
    <>
      {error && <div className="alert">{error.error}</div>}

      <section>
        <div className="card">
          <div className="card-head">
            <h2>
              {open ? "Being reconciled" : "Reconciled"}
            </h2>
            <span className="page-sub">
              {statement.matched} matched · {statement.ignored} set aside ·{" "}
              <strong style={{ color: unmatched > 0 ? "var(--warn)" : "var(--ink)" }}>
                {unmatched} unexplained
              </strong>
            </span>
          </div>
          <div className="card-body">
            <div className="actions">
              {open && (
                <>
                  <form action={autoFormAction}>
                    <input type="hidden" name="statement_id" value={statement.id} />
                    <button type="submit" className="btn ghost" disabled={autoRunning || unmatched === 0}>
                      {autoRunning ? "Matching…" : "Match the obvious ones"}
                    </button>
                  </form>
                  <form action={statusFormAction}>
                    <input type="hidden" name="statement_id" value={statement.id} />
                    <input type="hidden" name="status" value="RECONCILED" />
                    <button type="submit" disabled={closing || unmatched > 0}>
                      {closing ? "…" : "Mark reconciled"}
                    </button>
                  </form>
                </>
              )}
              {!open && (
                <form action={statusFormAction}>
                  <input type="hidden" name="statement_id" value={statement.id} />
                  <input type="hidden" name="status" value="OPEN" />
                  <button type="submit" className="ghost" disabled={closing}>Reopen</button>
                </form>
              )}
              <span className="page-sub">
                {unmatched > 0
                  ? <>
                      {money(statement.unmatched_value)} still unexplained. Automatic
                      matching only takes the lines that can mean one thing —
                      same amount, within seven days, one candidate each side.
                    </>
                  : <>Every line is either matched or set aside with a reason.</>}
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* The two sides. A grid rather than two cards stacked, because the
          whole point is reading across. */}
      <section>
        <div className="reconcile-grid">
          <div className="card">
            <div className="card-head">
              <h2>On the statement</h2>
              <span className="page-sub">
                what {statement.account_name} says · {statement.lines} lines
              </span>
            </div>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Date</th><th>Description</th>
                    <th className="r">Amount</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => {
                    const isPicked = l.id === selected;
                    return (
                      <tr key={l.id}
                          className={isPicked ? "picked" : undefined}
                          onClick={() => open && l.status !== "MATCHED"
                            ? setSelected(isPicked ? null : l.id) : undefined}
                          style={{ cursor: open && l.status !== "MATCHED" ? "pointer" : undefined }}>
                        <td className="code">{day(l.txn_date)}</td>
                        <td className="wrap">
                          {l.description ?? "—"}
                          {l.reference && <div className="subline">{l.reference}</div>}
                          {l.status === "MATCHED" && l.entry_no && (
                            <div className="subline">
                              ↔{" "}
                              {l.document_id ? (
                                <Link href={`/documents/${l.document_id}`}
                                      style={{ color: "var(--brand)" }}>
                                  {l.doc_no ?? l.entry_no}
                                </Link>
                              ) : l.entry_no}
                              {l.partner_name && <> · {l.partner_name}</>}
                            </div>
                          )}
                          {l.status === "IGNORED" && l.ignore_reason && (
                            <div className="subline">Set aside — {l.ignore_reason}</div>
                          )}
                        </td>
                        <td className="r" style={{
                          color: Number(l.amount) < 0 ? "var(--bad)" : undefined,
                        }}>
                          {money(l.amount)}
                        </td>
                        <td>
                          {l.status === "MATCHED" && <span className="pill ok">matched</span>}
                          {l.status === "IGNORED" && <span className="pill">set aside</span>}
                          {l.status === "UNMATCHED" && (
                            <span className="pill warn">unexplained</span>
                          )}
                          {open && (
                            <div className="actions" style={{ marginTop: "0.3rem" }}>
                              {l.status === "MATCHED" && (
                                <form action={unmatchFormAction}>
                                  <input type="hidden" name="statement_line_id" value={l.id} />
                                  <button type="submit" className="btn ghost tiny">Unmatch</button>
                                </form>
                              )}
                              {l.status === "IGNORED" && (
                                <form action={ignoreFormAction}>
                                  <input type="hidden" name="statement_line_id" value={l.id} />
                                  <input type="hidden" name="unignore" value="1" />
                                  <button type="submit" className="btn ghost tiny">Bring back</button>
                                </form>
                              )}
                              {l.status === "UNMATCHED" && (
                                <button type="button" className="btn ghost tiny"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setIgnoring(ignoring === l.id ? null : l.id);
                                        }}>
                                  Set aside
                                </button>
                              )}
                            </div>
                          )}
                          {ignoring === l.id && (
                            <form action={ignoreFormAction} className="form"
                                  style={{ marginTop: "0.4rem" }}>
                              <input type="hidden" name="statement_line_id" value={l.id} />
                              <div className="field">
                                <label htmlFor={`why-${l.id}`}>Why</label>
                                <input id={`why-${l.id}`} name="reason" type="text" required
                                       placeholder="Opening balance row · not our account" />
                              </div>
                              <div className="actions">
                                <button type="submit" className="btn tiny">Set aside</button>
                                <button type="button" className="btn ghost tiny"
                                        onClick={() => setIgnoring(null)}>Cancel</button>
                              </div>
                            </form>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>In our books</h2>
              <span className="page-sub">
                {picked
                  ? <>
                      {exactCount > 0
                        ? `${exactCount} the same amount`
                        : "nothing the same amount"}
                      {" "}· {candidates.length} unreconciled
                    </>
                  : <>{candidates.length} unreconciled entries on this account</>}
              </span>
            </div>

            {!open ? (
              <div className="empty">This statement is reconciled.</div>
            ) : !picked ? (
              <div className="empty">
                Pick a line on the left to match it against one of these.
              </div>
            ) : candidates.length === 0 ? (
              <div className="empty">
                Nothing unreconciled on this account. If the statement line is a
                real transaction the books have never seen — a bank charge, say —
                raise a{" "}
                <Link href="/finance/bank-payment" style={{ color: "var(--brand)" }}>
                  bank payment
                </Link>{" "}
                for it, then match against that.
              </div>
            ) : (
              <div className="tablewrap">
                <table>
                  <thead>
                    <tr>
                      <th>Date</th><th>Entry</th>
                      <th className="r">Amount</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {ranked.map((c) => {
                      const same = Math.abs(Number(c.amount) - Number(picked.amount)) < 0.0001;
                      return (
                        <tr key={c.journal_line_id}>
                          <td className="code">{day(c.entry_date)}</td>
                          <td className="wrap">
                            {c.document_id ? (
                              <Link href={`/documents/${c.document_id}`}
                                    style={{ color: "var(--brand)" }}>
                                {c.doc_no ?? c.entry_no}
                              </Link>
                            ) : c.entry_no}
                            {c.partner_name && <div className="subline">{c.partner_name}</div>}
                            {c.memo && <div className="subline">{c.memo}</div>}
                          </td>
                          <td className="r" style={{
                            color: Number(c.amount) < 0 ? "var(--bad)" : undefined,
                            fontWeight: same ? 600 : undefined,
                          }}>
                            {money(c.amount)}
                            {!same && (
                              <div className="subline">
                                {money(Number(c.amount) - Number(picked.amount))} out
                              </div>
                            )}
                          </td>
                          <td>
                            <form action={matchFormAction}>
                              <input type="hidden" name="statement_line_id" value={picked.id} />
                              <input type="hidden" name="journal_line_id"
                                     value={c.journal_line_id} />
                              <button type="submit" className={same ? "btn tiny" : "btn ghost tiny"}>
                                Match
                              </button>
                            </form>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
