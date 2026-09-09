"use client";

import { useMemo, useState } from "react";
import { useActionState } from "react";
import { Boxes, Building2, CalendarDays, Landmark, Users, Wallet } from "lucide-react";
import { money } from "@/lib/format";
import type { ActionResult } from "@/lib/actions";

type Item = { id: string; code: string; name: string; is_stocked?: boolean };
type Named = { id: string; code: string; name: string };
type Account = Named & { account_type: string; is_control: boolean; subledger?: string | null };

type StockRow = { key: number; itemId: string; locationId: string; qty: string; unitCost: string };
type PartnerRow = { key: number; partnerId: string; reference: string; amount: string; dueDate: string };
type AccountRow = {
  key: number; accountId: string; debit: string; credit: string;
  /**
   * Which branch this opening balance belongs to. Opening balances carried no
   * branch at all, which is how a company's opening cash ended up in the
   * company total and in none of its branches — the branch reports then added
   * up to less than the company with nothing saying why. The till is at a
   * branch on the day you start, the same as it is every day after.
   */
  locationId: string;
};

const n = (v: string) => {
  const x = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(x) ? x : 0;
};

/**
 * The cutover: what the business already had on the day it started using
 * this system.
 *
 * One page rather than six, though the steps are numbered as steps. The last
 * one is "check that it reconciles", and you cannot check a total against
 * figures on five screens you have already left — the remainder at the foot
 * has to move as the rows above it are typed, or it is not a check.
 *
 * Nothing is saved until it is posted. A half-entered cutover sitting in the
 * database as a draft is a second source of truth about what the company
 * owned, and the whole point of a batch is that there is exactly one.
 */
export function OpeningSetup({
  action, items, locations, branches, customers, suppliers, accounts, today,
}: {
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  items: Item[];
  /** Stock locations — where the goods are. */
  locations: Named[];
  /** Branches — where the money is. */
  branches: Named[];
  customers: Named[];
  suppliers: Named[];
  accounts: Account[];
  today: string;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    action as never, null,
  );

  const [cutover, setCutover] = useState(today);
  const [stock, setStock] = useState<StockRow[]>([
    { key: 1, itemId: "", locationId: locations[0]?.id ?? "", qty: "", unitCost: "" },
  ]);
  const [receivables, setReceivables] = useState<PartnerRow[]>([
    { key: 1, partnerId: "", reference: "", amount: "", dueDate: "" },
  ]);
  const [payables, setPayables] = useState<PartnerRow[]>([
    { key: 1, partnerId: "", reference: "", amount: "", dueDate: "" },
  ]);
  const [others, setOthers] = useState<AccountRow[]>([
    { key: 1, accountId: "", debit: "", credit: "", locationId: branches[0]?.id ?? "" },
  ]);

  // Only what a subledger does not own. Stock, receivables and payables have
  // their own steps, and entering them here as well is exactly the double
  // count this screen exists to prevent.
  const openable = accounts.filter((a) => !a.is_control && !a.subledger);
  const stocked = items.filter((i) => i.is_stocked !== false);

  const stockValue = useMemo(
    () => stock.reduce((s, r) => s + (r.itemId ? n(r.qty) * n(r.unitCost) : 0), 0), [stock]);
  const arTotal = useMemo(
    () => receivables.reduce((s, r) => s + (r.partnerId ? n(r.amount) : 0), 0), [receivables]);
  const apTotal = useMemo(
    () => payables.reduce((s, r) => s + (r.partnerId ? n(r.amount) : 0), 0), [payables]);
  const othersNet = useMemo(
    () => others.reduce((s, r) => s + (r.accountId ? n(r.debit) - n(r.credit) : 0), 0), [others]);

  // Everything entered, netted. What is left goes to Opening Balance Equity —
  // stated rather than absorbed, because a remainder nobody looked at is how
  // a cutover quietly swallows a mistake.
  const entered = stockValue + arTotal - apTotal + othersNet;
  const toEquity = -entered;

  const rows = stock.filter((r) => r.itemId && n(r.qty) > 0).length
    + receivables.filter((r) => r.partnerId && n(r.amount)).length
    + payables.filter((r) => r.partnerId && n(r.amount)).length
    + others.filter((r) => r.accountId && (n(r.debit) || n(r.credit))).length;

  const payload = {
    cutoverDate: cutover,
    stock: stock.filter((r) => r.itemId && n(r.qty) > 0).map((r) => ({
      itemId: r.itemId, locationId: r.locationId, qty: n(r.qty), unitCost: n(r.unitCost),
    })),
    receivables: receivables.filter((r) => r.partnerId && n(r.amount)).map((r) => ({
      partnerId: r.partnerId, reference: r.reference, amount: n(r.amount),
      dueDate: r.dueDate || null,
    })),
    payables: payables.filter((r) => r.partnerId && n(r.amount)).map((r) => ({
      partnerId: r.partnerId, reference: r.reference, amount: n(r.amount),
      dueDate: r.dueDate || null,
    })),
    accounts: others.filter((r) => r.accountId && (n(r.debit) || n(r.credit))).map((r) => ({
      accountId: r.accountId, amount: n(r.debit) - n(r.credit),
      locationId: r.locationId || null,
    })),
  };

  const add = <T,>(set: React.Dispatch<React.SetStateAction<T[]>>, blank: (k: number) => T) =>
    set((rs) => [...rs, blank(Math.max(0, ...rs.map((r) => (r as { key: number }).key)) + 1)]);
  const drop = <T extends { key: number }>(
    set: React.Dispatch<React.SetStateAction<T[]>>, key: number,
  ) => set((rs) => (rs.length <= 1 ? rs : rs.filter((r) => r.key !== key)));

  const step = (no: number, icon: React.ReactNode, title: string, hint: string) => (
    <div className="card-head">
      <h2><span className="stepno">{no}</span> {icon} {title}</h2>
      <span className="page-sub">{hint}</span>
    </div>
  );

  return (
    <form action={formAction} className="form wide">
      {state && "error" in state && <div className="alert">{state.error}</div>}
      <input type="hidden" name="payload" value={JSON.stringify(payload)} />

      <section>
        <div className="card">
          {step(1, <CalendarDays size={14} aria-hidden="true" />, "Starting date",
            "The day you begin using this system")}
          <div className="card-body">
            <div className="row">
              <div className="field">
                <label htmlFor="cutover">Start trading in this system on</label>
                <input id="cutover" type="date" value={cutover} required
                       onChange={(e) => setCutover(e.target.value)} />
                <span className="hint">
                  Opening figures are dated the day before, so they are what was
                  true when you started rather than competing with day one&rsquo;s
                  own transactions.
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section>
        <div className="card">
          {step(2, <Boxes size={14} aria-hidden="true" />, "Opening stock",
            "What is on the shelf, and what it cost you")}
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Item</th><th>Warehouse</th>
                  <th className="r">Quantity</th><th className="r">Unit cost</th>
                  <th className="r">Value</th><th />
                </tr>
              </thead>
              <tbody>
                {stock.map((r) => (
                  <tr key={r.key}>
                    <td>
                      <select value={r.itemId} onChange={(e) => setStock((rs) =>
                        rs.map((x) => x.key === r.key ? { ...x, itemId: e.target.value } : x))}>
                        <option value="">Choose an item…</option>
                        {stocked.map((i) => (
                          <option key={i.id} value={i.id}>{i.code} · {i.name}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select value={r.locationId} onChange={(e) => setStock((rs) =>
                        rs.map((x) => x.key === r.key ? { ...x, locationId: e.target.value } : x))}>
                        {locations.map((l) => (
                          <option key={l.id} value={l.id}>{l.code} · {l.name}</option>
                        ))}
                      </select>
                    </td>
                    <td><input type="number" step="any" value={r.qty} onChange={(e) => setStock((rs) =>
                      rs.map((x) => x.key === r.key ? { ...x, qty: e.target.value } : x))} /></td>
                    <td><input type="number" step="any" value={r.unitCost} onChange={(e) => setStock((rs) =>
                      rs.map((x) => x.key === r.key ? { ...x, unitCost: e.target.value } : x))} /></td>
                    <td className="r m">{money(n(r.qty) * n(r.unitCost))}</td>
                    <td>
                      <button type="button" className="ghost tiny"
                              onClick={() => drop(setStock, r.key)}>×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={4}>
                    <button type="button" className="ghost tiny" onClick={() =>
                      add(setStock, (k) => ({ key: k, itemId: "", locationId: locations[0]?.id ?? "", qty: "", unitCost: "" }))}>
                      Add item
                    </button>
                  </td>
                  <td className="r">{money(stockValue)}</td><td />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </section>

      {[
        { no: 3, title: "Customer balances", icon: <Users size={14} aria-hidden="true" />,
          hint: "Unpaid invoices your customers still owe you",
          rows: receivables, set: setReceivables, partners: customers, who: "Customer" },
        { no: 4, title: "Supplier balances", icon: <Building2 size={14} aria-hidden="true" />,
          hint: "Unpaid bills you still owe your suppliers",
          rows: payables, set: setPayables, partners: suppliers, who: "Supplier" },
      ].map((s) => (
        <section key={s.no}>
          <div className="card">
            {step(s.no, s.icon, s.title, s.hint)}
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>{s.who}</th><th>Their invoice number</th><th>Due date</th>
                    <th className="r">Outstanding</th><th />
                  </tr>
                </thead>
                <tbody>
                  {s.rows.map((r) => (
                    <tr key={r.key}>
                      <td>
                        <select value={r.partnerId} onChange={(e) => s.set((rs) =>
                          rs.map((x) => x.key === r.key ? { ...x, partnerId: e.target.value } : x))}>
                          <option value="">Choose…</option>
                          {s.partners.map((p) => (
                            <option key={p.id} value={p.id}>{p.code} · {p.name}</option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input type="text" value={r.reference} placeholder="e.g. INV-8842"
                               onChange={(e) => s.set((rs) =>
                                 rs.map((x) => x.key === r.key ? { ...x, reference: e.target.value } : x))} />
                      </td>
                      <td>
                        <input type="date" value={r.dueDate} onChange={(e) => s.set((rs) =>
                          rs.map((x) => x.key === r.key ? { ...x, dueDate: e.target.value } : x))} />
                      </td>
                      <td>
                        <input type="number" step="any" value={r.amount} onChange={(e) => s.set((rs) =>
                          rs.map((x) => x.key === r.key ? { ...x, amount: e.target.value } : x))} />
                      </td>
                      <td>
                        <button type="button" className="ghost tiny"
                                onClick={() => drop(s.set, r.key)}>×</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3}>
                      <button type="button" className="ghost tiny" onClick={() =>
                        add(s.set, (k) => ({ key: k, partnerId: "", reference: "", amount: "", dueDate: "" }))}>
                        Add {s.who.toLowerCase()}
                      </button>
                    </td>
                    <td className="r">{money(s.no === 3 ? arTotal : apTotal)}</td><td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </section>
      ))}

      <section>
        <div className="card">
          {step(5, <Wallet size={14} aria-hidden="true" />, "Other balances",
            "Cash, bank, loans, capital — everything a subledger does not own")}
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  {branches.length > 1 && <th>Branch</th>}
                  <th className="r">Debit</th><th className="r">Credit</th><th />
                </tr>
              </thead>
              <tbody>
                {others.map((r) => (
                  <tr key={r.key}>
                    <td>
                      <select value={r.accountId} onChange={(e) => setOthers((rs) =>
                        rs.map((x) => x.key === r.key ? { ...x, accountId: e.target.value } : x))}>
                        <option value="">Choose an account…</option>
                        {openable.map((a) => (
                          <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                        ))}
                      </select>
                    </td>
                    {branches.length > 1 && (
                      <td>
                        <select value={r.locationId} onChange={(e) => setOthers((rs) =>
                          rs.map((x) => x.key === r.key ? { ...x, locationId: e.target.value } : x))}>
                          {branches.map((b) => (
                            <option key={b.id} value={b.id}>{b.code} · {b.name}</option>
                          ))}
                        </select>
                      </td>
                    )}
                    <td><input type="number" step="any" value={r.debit} onChange={(e) => setOthers((rs) =>
                      rs.map((x) => x.key === r.key ? { ...x, debit: e.target.value, credit: "" } : x))} /></td>
                    <td><input type="number" step="any" value={r.credit} onChange={(e) => setOthers((rs) =>
                      rs.map((x) => x.key === r.key ? { ...x, credit: e.target.value, debit: "" } : x))} /></td>
                    <td>
                      <button type="button" className="ghost tiny"
                              onClick={() => drop(setOthers, r.key)}>×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>
                    <button type="button" className="ghost tiny" onClick={() =>
                      add(setOthers, (k) => ({ key: k, accountId: "", debit: "", credit: "",
                                               locationId: branches[0]?.id ?? "" }))}>
                      Add account
                    </button>
                  </td>
                  <td className="r" colSpan={branches.length > 1 ? 3 : 2}>{money(othersNet)}</td><td />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </section>

      <section>
        <div className="card">
          {step(6, <Landmark size={14} aria-hidden="true" />, "Review and post",
            "What this will write, and what balances it")}
          <div className="card-body">
            <dl className="kv">
              <dt>Opening stock</dt><dd className="r">{money(stockValue)}</dd>
              <dt>Customers owe you</dt><dd className="r">{money(arTotal)}</dd>
              <dt>You owe suppliers</dt><dd className="r">({money(apTotal)})</dd>
              <dt>Other balances, net</dt><dd className="r">{money(othersNet)}</dd>
              <dt><strong>Balancing entry to Opening Balance Equity</strong></dt>
              <dd className="r"><strong>{money(toEquity)}</strong></dd>
            </dl>
            <p className="hint" style={{ marginTop: "0.5rem" }}>
              Everything above is balanced against Opening Balance Equity, which
              nets to nil once the whole position is in. Nothing here touches
              sales, cost of sales or GR/IR: none of it was earned or bought in
              this system, and a cutover that moved those accounts would report
              last year&rsquo;s trading as this year&rsquo;s.
            </p>
          </div>
        </div>
      </section>

      <div className="actions form-commit">
        <button type="submit" disabled={pending || rows === 0}>
          {pending ? "Posting…" : `Post opening balances (${rows} line${rows === 1 ? "" : "s"})`}
        </button>
        <span className="page-sub">
          Posted once. A company can have one opening batch, so this cannot be
          entered twice by accident.
        </span>
      </div>
    </form>
  );
}
