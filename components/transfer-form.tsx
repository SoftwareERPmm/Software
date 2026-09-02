"use client";

import { useActionState, useState } from "react";
import type { ActionResult } from "@/lib/actions";

type Account = { id: string; code: string; name: string };
type Branch = { id: string; code: string; name: string };

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

export function TransferForm({
  action,
  accounts,
  branches,
  today,
}: {
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  accounts: Account[];
  branches: Branch[];
  today: string;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    action as never,
    null
  );

  const [fromId, setFromId] = useState(accounts[0]?.id ?? "");
  const [toId, setToId] = useState(accounts[1]?.id ?? "");
  const [amount, setAmount] = useState("");

  const amt = Number(amount) || 0;
  const same = fromId === toId;
  const from = accounts.find((a) => a.id === fromId);
  const to = accounts.find((a) => a.id === toId);

  return (
    <form action={formAction} className="form">
      {state && "error" in state && <div className="alert">{state.error}</div>}

      <div className="card">
        <div className="card-head"><h2>Move money</h2></div>
        <div className="card-body">
          <div className="row">
            <div className="field">
              <label htmlFor="from_account_id">From</label>
              <select id="from_account_id" name="from_account_id" value={fromId}
                onChange={(e) => setFromId(e.target.value)} required>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                ))}
              </select>
            </div>

            {branches.length > 0 && (
              <div className="field">
                <label htmlFor="from_location_id">From branch</label>
                <select id="from_location_id" name="from_location_id" defaultValue="">
                  <option value="">None</option>
                  {branches.map((l) => (
                    <option key={l.id} value={l.id}>{l.code} · {l.name}</option>
                  ))}
                </select>
              </div>
            )}

            <div className="field">
              <label htmlFor="to_account_id">To</label>
              <select id="to_account_id" name="to_account_id" value={toId}
                onChange={(e) => setToId(e.target.value)} required
                style={same ? { borderColor: "var(--bad)" } : undefined}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                ))}
              </select>
            </div>

            {branches.length > 0 && (
              <div className="field">
                <label htmlFor="to_location_id">To branch</label>
                <select id="to_location_id" name="to_location_id" defaultValue="">
                  <option value="">None</option>
                  {branches.map((l) => (
                    <option key={l.id} value={l.id}>{l.code} · {l.name}</option>
                  ))}
                </select>
              </div>
            )}

            <div className="field">
              <label htmlFor="amount">Amount</label>
              <input id="amount" name="amount" type="number" min="0" step="any"
                value={amount} onChange={(e) => setAmount(e.target.value)} required />
            </div>

            <div className="field">
              <label htmlFor="doc_date">Date</label>
              <input id="doc_date" name="doc_date" type="date" defaultValue={today} required />
            </div>
          </div>

          {same && <div className="alert" style={{ marginTop: "1rem" }}>Choose two different accounts.</div>}

          {!same && amt > 0 && from && to && (
            <div className="posting" style={{ marginTop: "1rem" }}>
              {`Dr  ${to.code} ${to.name.padEnd(26)}${fmt(amt).padStart(12)}\n` +
               `    Cr  ${from.code} ${from.name.padEnd(22)}${fmt(amt).padStart(12)}`}
            </div>
          )}
        </div>
      </div>

      <div className="row">
        <div className="field">
          <label htmlFor="reference">Reference</label>
          <input id="reference" name="reference" type="text" placeholder="Slip or cheque no." />
        </div>
        <div className="field">
          <label htmlFor="memo">Description</label>
          <textarea id="memo" name="memo" rows={2} placeholder="What this transfer is for — English or Myanmar" />
        </div>
      </div>

      <div className="actions">
        <button type="submit" disabled={pending || same || amt <= 0}>
          {pending ? "Posting…" : amt > 0 ? `Transfer ${fmt(amt)}` : "Transfer"}
        </button>
      </div>
    </form>
  );
}
