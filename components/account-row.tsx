"use client";

import { useActionState, useState } from "react";
import type { ActionResult } from "@/lib/actions";
import { ConfirmDelete } from "./confirm-delete";
import { ACCOUNT_TYPE_LABEL } from "./account-form";

export type CoaAccount = {
  id: string; code: string; name: string; name_my: string | null;
  account_type: string; parent_id: string | null;
  is_postable: boolean; is_control: boolean; is_active: boolean;
  currency: string | null; is_cash_account: boolean; is_bank_account: boolean;
  system_roles: string[]; rule_roles: string[];
  posting_count: number; child_count: number;
};

const TYPES = ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "COGS", "EXPENSE"];

const moneyKind = (a: CoaAccount) =>
  a.is_bank_account ? "bank" : a.is_cash_account ? "cash" : "";

export function AccountRow({
  account,
  accounts,
  depth,
  currencies,
  updateAction,
  deactivateAction,
  activateAction,
  deleteAction,
}: {
  account: CoaAccount;
  accounts: CoaAccount[];
  depth: number;
  currencies: string[];
  updateAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  deactivateAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  activateAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  deleteAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
}) {
  const [editing, setEditing] = useState(false);
  const [type, setType] = useState(account.account_type);

  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    updateAction as never,
    null
  );
  const [deactState, deactFormAction] = useActionState<ActionResult | null, FormData>(
    deactivateAction as never,
    null
  );
  const [actState, actFormAction] = useActionState<ActionResult | null, FormData>(
    activateAction as never,
    null
  );
  const [delState, delFormAction, delPending] = useActionState<ActionResult | null, FormData>(
    deleteAction as never,
    null
  );

  // The posting engine resolves these by role; retiring one breaks posting.
  const locked = account.system_roles.length > 0 || account.rule_roles.length > 0;
  const lockedBy = [...account.system_roles, ...account.rule_roles]
    .map((r) => r.replace(/_/g, " ").toLowerCase())
    .join(", ");

  const parents = accounts.filter(
    (a) => a.id !== account.id && a.account_type === type && a.posting_count === 0
  );


  if (editing) {
    return (
      <tr>
        <td colSpan={5}>
          <form action={formAction} className="form" style={{ padding: "0.5rem 0" }}>
            {state && "error" in state && <div className="alert">{state.error}</div>}
            <input type="hidden" name="id" value={account.id} />

            <div className="row">
              <div className="field">
                <label>Code</label>
                <input name="code" type="text" defaultValue={account.code} required />
              </div>
              <div className="field">
                <label>Name</label>
                <input name="name" type="text" defaultValue={account.name} required />
              </div>
              <div className="field">
                <label>Name (Burmese)</label>
                <input name="name_my" type="text" defaultValue={account.name_my ?? ""} />
              </div>
              <div className="field">
                <label>Type</label>
                <select name="account_type" value={type} onChange={(e) => setType(e.target.value)}
                  disabled={account.posting_count > 0}>
                  {TYPES.map((t) => (
                    <option key={t} value={t}>{ACCOUNT_TYPE_LABEL[t]}</option>
                  ))}
                </select>
                {account.posting_count > 0 && (
                  <>
                    <input type="hidden" name="account_type" value={account.account_type} />
                    <span className="hint">Fixed once posted to</span>
                  </>
                )}
              </div>
              <div className="field">
                <label>Sits under</label>
                <select name="parent_id" defaultValue={account.parent_id ?? ""}>
                  <option value="">— nothing, top level —</option>
                  {parents.map((a) => (
                    <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Money account</label>
                <select name="money_kind" defaultValue={moneyKind(account)}>
                  <option value="">Not a money account</option>
                  <option value="cash">Cash / till</option>
                  <option value="bank">Bank</option>
                </select>
              </div>
              <div className="field">
                <label>Currency</label>
                <select name="currency" defaultValue={account.currency ?? ""}>
                  <option value="">Any</option>
                  {currencies.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
            </div>

            <label className="check" style={{ marginTop: "0.4rem" }}>
              <input name="is_active" type="checkbox" defaultChecked={account.is_active} />
              Active
            </label>

            <div className="actions" style={{ marginTop: "0.5rem" }}>
              <button type="submit" disabled={pending}>{pending ? "Saving…" : "Save"}</button>
              <button type="button" className="ghost tiny" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </form>
        </td>
      </tr>
    );
  }

  const isHeading = !account.is_postable;

  return (
    <tr className={isHeading ? "coa-section" : undefined}>
      {/* A heading is a section of the chart, not an account anyone posts to,
          so it reads as one: the name carries the row and the code and type
          columns stay empty rather than repeating a number nobody quotes and
          a type that belongs to the accounts underneath. The code is still
          there to edit — it is on the Edit form, where changing it belongs. */}
      <td className="code" style={{ paddingLeft: `${1 + depth * 1.4}rem` }}>
        {isHeading ? "" : account.code}
      </td>
      <td className="wrap" style={{ paddingLeft: isHeading ? `${1 + depth * 1.4}rem` : undefined }}>
        <strong style={{ fontWeight: isHeading ? 700 : 400 }}>{account.name}</strong>
        {account.name_my && (
          <div className="subline" style={{ fontWeight: 400 }}>{account.name_my}</div>
        )}
      </td>
      <td style={{ color: "var(--muted)" }}>
        {isHeading ? "" : (ACCOUNT_TYPE_LABEL[account.account_type] ?? account.account_type)}
      </td>
      <td>
        {isHeading && <span className="pill">heading</span>}
        {account.is_control && <> <span className="pill warn">control</span></>}
        {account.is_bank_account && <> <span className="pill ok">bank</span></>}
        {!account.is_bank_account && account.is_cash_account && <> <span className="pill ok">cash</span></>}
        {account.currency && <> <span className="pill">{account.currency}</span></>}
        {!account.is_active && <> <span className="pill overdue">inactive</span></>}
        {locked && <> <span className="pill" title={`Used by the posting engine for ${lockedBy}`}>in use by posting</span></>}
      </td>
      <td>
        <span className="actions">
          <button type="button" className="ghost tiny" onClick={() => setEditing(true)}>Edit</button>

          {account.is_active && !locked && (
            <form action={deactFormAction} style={{ display: "inline" }}>
              <input type="hidden" name="id" value={account.id} />
              <button type="submit" className="warn tiny">Deactivate</button>
            </form>
          )}

          {/* No `locked` guard here: the lock exists to stop an account the
              posting engine needs being retired, so a locked account that is
              somehow inactive is exactly the one most worth putting back. */}
          {!account.is_active && (
            <form action={actFormAction} style={{ display: "inline" }}>
              <input type="hidden" name="id" value={account.id} />
              <button type="submit" className="ghost tiny">Reactivate</button>
            </form>
          )}

          {!locked && account.posting_count === 0 && account.child_count === 0 && (
            <ConfirmDelete
            action={delFormAction}
            pending={delPending}
            error={delState && "error" in delState ? delState.error : null}
            title={`Delete ${account.code} ${account.name}?`}
            detail="This cannot be undone."
          >
            <input type="hidden" name="id" value={account.id} />
          </ConfirmDelete>
          )}

          {account.posting_count > 0 && (
            <span className="hint" style={{ color: "var(--muted)" }}>
              {account.posting_count} posting{account.posting_count === 1 ? "" : "s"}
            </span>
          )}
        </span>

        {actState && "error" in actState && (
          <div className="hint" style={{ color: "var(--bad)" }}>{actState.error}</div>
        )}
        {deactState && "error" in deactState && (
          <div className="hint" style={{ color: "var(--bad)" }}>{deactState.error}</div>
        )}
        {delState && "error" in delState && (
          <div className="hint" style={{ color: "var(--bad)" }}>{delState.error}</div>
        )}
      </td>
    </tr>
  );
}
