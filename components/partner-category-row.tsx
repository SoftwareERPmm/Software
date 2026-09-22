"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { ActionResult } from "@/lib/actions";
import { RowMenu } from "./row-menu";

type Category = {
  id: string; code: string; name: string; name_my: string | null;
  note: string | null; sort_order: number | string;
  partners: string | number; customers: string | number;
  is_active: boolean;
};

/**
 * One kind of trade.
 *
 * Delete is offered only while nothing is filed under it. The foreign key is
 * nullable, so deleting a category in use would succeed and silently blank
 * the classification on every customer in it — the server refuses, and the
 * menu does not offer it in the first place.
 */
export function PartnerCategoryRow({
  category, updateAction, setActiveAction, deleteAction,
}: {
  category: Category;
  updateAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  setActiveAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  deleteAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
}) {
  const [editing, setEditing] = useState(false);
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    updateAction as never, null,
  );
  const [activeState, activeFormAction] = useActionState<ActionResult | null, FormData>(
    setActiveAction as never, null,
  );
  const [delState, delFormAction] = useActionState<ActionResult | null, FormData>(
    deleteAction as never, null,
  );

  const router = useRouter();
  useEffect(() => {
    for (const st of [state, activeState, delState]) {
      if (st && "ok" in st) { router.refresh(); return; }
    }
  }, [state, activeState, delState, router]);

  useEffect(() => { if (state && "ok" in state) setEditing(false); }, [state]);

  const inUse = Number(category.partners) > 0;
  const error = [state, activeState, delState]
    .find((s) => s && "error" in s) as { error: string } | undefined;

  if (editing) {
    return (
      <tr>
        <td colSpan={8}>
          {error && <div className="alert">{error.error}</div>}
          <form action={formAction} className="form">
            <input type="hidden" name="id" value={category.id} />
            <div className="row">
              <div className="field">
                <label htmlFor={`n-${category.id}`}>Name</label>
                <input id={`n-${category.id}`} name="name" type="text"
                       defaultValue={category.name} required />
              </div>
              <div className="field">
                <label htmlFor={`my-${category.id}`}>Name (Burmese)</label>
                <input id={`my-${category.id}`} name="name_my" type="text"
                       defaultValue={category.name_my ?? ""} />
              </div>
              <div className="field">
                <label htmlFor={`o-${category.id}`}>Order</label>
                <input id={`o-${category.id}`} name="sort_order" type="number"
                       defaultValue={String(category.sort_order)} />
              </div>
            </div>
            <div className="field" style={{ marginTop: "0.75rem" }}>
              <label htmlFor={`note-${category.id}`}>Note</label>
              <input id={`note-${category.id}`} name="note" type="text"
                     defaultValue={category.note ?? ""} />
            </div>
            <div className="actions">
              <button type="submit" disabled={pending}>
                {pending ? "Saving…" : "Save"}
              </button>
              <button type="button" className="ghost" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </form>
        </td>
      </tr>
    );
  }

  return (
    <>
      {error && (
        <tr><td colSpan={8}><div className="alert">{error.error}</div></td></tr>
      )}
      <tr>
        <td className="r code">{String(category.sort_order)}</td>
        <td className="code">{category.code}</td>
        <td className="wrap">
          {category.name}
          {category.name_my && <div className="subline">{category.name_my}</div>}
        </td>
        <td className="wrap">{category.note ?? "—"}</td>
        <td className="r">
          {Number(category.customers) > 0 ? (
            <Link href={`/partners?role=customer&category=${category.id}`}
                  style={{ color: "var(--brand)" }}>
              {String(category.customers)}
            </Link>
          ) : "—"}
        </td>
        <td className="r">{Number(category.partners) || "—"}</td>
        <td>
          {category.is_active
            ? <span className="pill ok">active</span>
            : <span className="pill warn">inactive</span>}
        </td>
        <td>
          <RowMenu label={`Actions for ${category.name}`}>
            <button type="button" onClick={() => setEditing(true)}>Edit</button>
            <form action={activeFormAction}>
              <input type="hidden" name="id" value={category.id} />
              <input type="hidden" name="active" value={category.is_active ? "0" : "1"} />
              <button type="submit">
                {category.is_active ? "Deactivate" : "Activate"}
              </button>
            </form>
            {!inUse && (
              <form action={delFormAction}>
                <input type="hidden" name="id" value={category.id} />
                <button type="submit">Delete</button>
              </form>
            )}
          </RowMenu>
        </td>
      </tr>
    </>
  );
}
