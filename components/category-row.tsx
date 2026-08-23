"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import type { ActionResult } from "@/lib/actions";

type Category = {
  id: string; code: string; name: string; name_my: string | null;
  is_active: boolean; inside: number; total: number;
};

/** Reused on the root categories page, each category's own child listing,
 *  and the flat sub-categories list — all show the same shape (a category
 *  with what's inside it); the sub-categories list additionally passes
 *  parentName, since that flat list mixes children of many categories. */
export function CategoryRow({
  category,
  returnTo,
  parentName,
  showInside = true,
  updateAction,
  deleteAction,
  deactivateAction,
}: {
  category: Category;
  returnTo: string;
  /** Shown as its own column when set — the parent category, for a flat list spanning many parents. */
  parentName?: string | null;
  /** Categories two levels deep can never have children — leave this off wherever every row shown is at that depth, since it would only ever read as 0. */
  showInside?: boolean;
  updateAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  deleteAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  deactivateAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
}) {
  const [editing, setEditing] = useState(false);
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    updateAction as never,
    null
  );
  const [, deactFormAction] = useActionState<ActionResult | null, FormData>(
    deactivateAction as never,
    null
  );
  const [delState, delFormAction, delPending] = useActionState<ActionResult | null, FormData>(
    deleteAction as never,
    null
  );

  function confirmDelete(e: React.FormEvent<HTMLFormElement>) {
    if (!confirm(`Delete ${category.name}? This can't be undone.`)) e.preventDefault();
  }

  if (editing) {
    return (
      <tr>
        <td colSpan={(parentName !== undefined ? 5 : 4) + (showInside ? 1 : 0)}>
          <form action={formAction} className="form" style={{ padding: "0.5rem 0" }}>
            {state && "error" in state && <div className="alert">{state.error}</div>}
            <input type="hidden" name="id" value={category.id} />
            <input type="hidden" name="return_to" value={returnTo} />
            <span className="page-sub">
              {category.code} — code is fixed here; use Restructure on the category&rsquo;s own page to move or resegment it.
            </span>
            <div className="row" style={{ marginTop: "0.4rem" }}>
              <div className="field">
                <label>Name</label>
                <input name="name" type="text" defaultValue={category.name} required />
              </div>
              <div className="field">
                <label>Name (Burmese)</label>
                <input name="name_my" type="text" defaultValue={category.name_my ?? ""} />
              </div>
            </div>
            <label className="check" style={{ marginTop: "0.4rem" }}>
              <input name="is_active" type="checkbox" defaultChecked={category.is_active} />
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

  return (
    <tr className="link">
      <td className="code">
        <Link href={`/items/categories/${category.id}`} style={{ color: "var(--dr)" }}>
          {category.code}
        </Link>
      </td>
      <td className="wrap">
        <Link href={`/items/categories/${category.id}`}>{category.name}</Link>
        {category.name_my && (
          <div className="subline">{category.name_my}</div>
        )}
        {!category.is_active && <> <span className="pill warn">inactive</span></>}
      </td>
      {parentName !== undefined && (
        <td className="wrap" style={{ color: "var(--muted)" }}>{parentName ?? "—"}</td>
      )}
      {showInside && <td className="r">{category.inside || ""}</td>}
      <td className="r">{category.total || ""}</td>
      <td>
        <span className="actions">
          <Link href={`/items/categories/${category.id}`} className="btn ghost tiny">Open &rarr;</Link>
          <button type="button" className="ghost tiny" onClick={() => setEditing(true)}>Edit</button>
          {category.is_active && (
            <form action={deactFormAction} style={{ display: "inline" }}>
              <input type="hidden" name="id" value={category.id} />
              <input type="hidden" name="return_to" value={returnTo} />
              <button type="submit" className="warn tiny">Deactivate</button>
            </form>
          )}
          <form action={delFormAction} onSubmit={confirmDelete} style={{ display: "inline" }}>
            <input type="hidden" name="id" value={category.id} />
            <input type="hidden" name="return_to" value={returnTo} />
            <button type="submit" className="danger tiny" disabled={delPending}>
              {delPending ? "Deleting…" : "Delete"}
            </button>
          </form>
        </span>
        {delState && "error" in delState && (
          <div className="hint" style={{ color: "var(--bad)" }}>{delState.error}</div>
        )}
      </td>
    </tr>
  );
}
