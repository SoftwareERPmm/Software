"use client";

import { useActionState, useState } from "react";
import type { ActionResult } from "@/lib/actions";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function SetupForm({
  action,
  defaultYear,
}: {
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  defaultYear: number;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    action as never,
    null
  );

  // Myanmar's financial year has moved more than once, so this is asked
  // rather than assumed. April is the current convention.
  const [month, setMonth] = useState(4);
  const [year, setYear] = useState(defaultYear);

  const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
  const end = new Date(startDate);
  end.setFullYear(end.getFullYear() + 1);
  end.setDate(end.getDate() - 1);

  return (
    <form action={formAction} className="form">
      {state && "error" in state && <div className="alert">{state.error}</div>}

      <input type="hidden" name="fiscal_year_start" value={startDate} />
      <input type="hidden" name="fiscal_year_start_month" value={month} />

      <div className="card">
        <div className="card-head"><h2>The company</h2></div>
        <div className="card-body">
          <div className="row">
            <div className="field">
              <label htmlFor="name">Name</label>
              <input id="name" name="name" type="text" required autoFocus
                placeholder="Shwe Yadanar Trading Co., Ltd" />
            </div>
            <div className="field">
              <label htmlFor="name_my">Name (Burmese)</label>
              <input id="name_my" name="name_my" type="text" />
              <span className="hint">Optional. Unicode only</span>
            </div>
            <div className="field">
              <label htmlFor="code">Short code</label>
              <input id="code" name="code" type="text" required placeholder="SHWE" maxLength={12} />
              <span className="hint">Used internally, never printed</span>
            </div>
            <div className="field">
              <label htmlFor="base_currency">Reporting currency</label>
              <select id="base_currency" name="base_currency" defaultValue="MMK">
                <option value="MMK">MMK &middot; Myanmar Kyat</option>
                <option value="USD">USD &middot; US Dollar</option>
                <option value="THB">THB &middot; Thai Baht</option>
                <option value="SGD">SGD &middot; Singapore Dollar</option>
              </select>
              <span className="hint">The books are kept in this. It cannot be changed later.</span>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Financial year</h2></div>
        <div className="card-body">
          <div className="row">
            <div className="field">
              <label htmlFor="month">Starts in</label>
              <select id="month" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
                {MONTHS.map((m, i) => (
                  <option key={m} value={i + 1}>{m}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="year">Of year</label>
              <input id="year" type="number" min="2000" max="2100" value={year}
                onChange={(e) => setYear(Number(e.target.value))} />
            </div>
          </div>

          <p className="page-sub" style={{ marginTop: "1rem" }}>
            Opens <span className="m">{startDate}</span> to{" "}
            <span className="m">{end.toISOString().slice(0, 10)}</span>, divided into
            twelve monthly periods. Nothing can be posted outside an open period.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Where stock is held</h2></div>
        <div className="card-body">
          <div className="row">
            <div className="field">
              <label htmlFor="office_name">Branch</label>
              <input id="office_name" name="office_name" type="text"
                defaultValue="Head Office" required />
            </div>
            <div className="field">
              <label htmlFor="warehouse_name">Warehouse</label>
              <input id="warehouse_name" name="warehouse_name" type="text"
                defaultValue="Main Warehouse" required />
              <span className="hint">Add more offices and warehouses later</span>
            </div>
          </div>
        </div>
      </div>

      <div className="note">
        <p>
          Also created: a 29-account chart covering assets, liabilities, equity,
          revenue, cost of sales and expenses; the eleven accounts the posting
          engine looks up by role; company-wide posting rules; wholesale and retail
          price levels; four units; and free-of-charge reasons. All of it can be
          renamed, extended or switched off afterwards.
        </p>
      </div>

      <div className="actions">
        <button type="submit" disabled={pending}>
          {pending ? "Setting up…" : "Create company"}
        </button>
      </div>
    </form>
  );
}
