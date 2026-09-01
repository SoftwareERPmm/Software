"use client";

import { useActionState, useState } from "react";
import type { ActionResult } from "@/lib/actions";

type Uom = { id: string; code: string; name: string };
type ParentOption = { id: string; code: string; name: string };

/**
 * Add a category at the level currently being viewed — or, when `categories`
 * is passed instead of a fixed `parentId`, add a sub category from a flat
 * list that isn't already scoped to one parent, with a dropdown to choose
 * which category it goes under.
 */
export function AddCategoryForm({
  action,
  parentId,
  parentCode,
  categories,
  returnTo,
  label,
  codeHint,
  nameHint,
}: {
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  parentId?: string | null;
  parentCode?: string;
  /** Categories to choose a parent from, when there isn't already one fixed parent. */
  categories?: ParentOption[];
  returnTo: string;
  label: string;
  codeHint: string;
  nameHint: string;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    action as never,
    null
  );
  const [open, setOpen] = useState(false);
  const [segment, setSegment] = useState("");
  const [chosenParentId, setChosenParentId] = useState(categories?.[0]?.id ?? "");

  const choosingParent = categories !== undefined;
  const effectiveParentCode = choosingParent
    ? categories?.find((c) => c.id === chosenParentId)?.code
    : parentCode;

  const composed = `${effectiveParentCode ?? ""}${segment}`;

  const nothingToChooseFrom = choosingParent && categories?.length === 0;

  if (!open) {
    return (
      <div className="actions">
        <button type="button" onClick={() => setOpen(true)} disabled={nothingToChooseFrom}>
          + {label}
        </button>
        {nothingToChooseFrom && (
          <span className="page-sub">Add a category first — a sub category needs one to go under.</span>
        )}
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>New {label.toLowerCase()}</h2>
        <span className="actions">
          {segment && (
            <span className="m" style={{ color: "var(--brand)" }}>Code will be {composed}</span>
          )}
          <button type="button" className="ghost tiny" onClick={() => setOpen(false)}>Cancel</button>
        </span>
      </div>
      <div className="card-body">
        <form action={formAction} className="form">
          {state && "error" in state && <div className="alert">{state.error}</div>}
          {!choosingParent && <input type="hidden" name="parent_id" value={parentId ?? ""} />}
          <input type="hidden" name="return_to" value={returnTo} />

          <div className="row">
            {choosingParent && (
              <div className="field">
                <label htmlFor="parent_id">Category</label>
                <select id="parent_id" name="parent_id" value={chosenParentId}
                  onChange={(e) => setChosenParentId(e.target.value)} required>
                  {categories?.length === 0 && <option value="">No categories yet</option>}
                  {categories?.map((c) => (
                    <option key={c.id} value={c.id}>{c.code} · {c.name}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="field">
              <label htmlFor="segment">Code segment</label>
              <input id="segment" name="segment" type="text" required autoFocus
                value={segment} onChange={(e) => setSegment(e.target.value)}
                placeholder={codeHint} />
              <span className="hint">
                {effectiveParentCode
                  ? `Added to ${effectiveParentCode} to make this category's code`
                  : "The start of every code beneath this category"}
              </span>
            </div>
            <div className="field">
              <label htmlFor="name">Name</label>
              <input id="name" name="name" type="text" required placeholder={nameHint} />
            </div>
            <div className="field">
              <label htmlFor="name_my">Name (Burmese)</label>
              <input id="name_my" name="name_my" type="text" />
            </div>
          </div>

          <div className="actions">
            <button type="submit" disabled={pending}>{pending ? "Saving…" : `Save ${label.toLowerCase()}`}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
