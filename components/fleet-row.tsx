"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { ActionResult } from "@/lib/actions";
import { RowMenu } from "./row-menu";

export type FleetField = {
  name: string;
  label: string;
  placeholder?: string;
  required?: boolean;
};

type Record_ = { id: string; code: string; is_active: boolean; trips: string | number }
  & Record<string, unknown>;

/**
 * One vehicle or one driver.
 *
 * The two are the same shape — a code that never changes, a handful of text
 * fields, and whether it is still in service — so they share a row driven by
 * a field list rather than being written twice. What differs between them is
 * vocabulary, which belongs in the caller.
 *
 * Neither is ever deleted. A truck sold or a driver who left still appears on
 * last year's trips, and removing the record would blank the answer to "who
 * drove this" on journeys that already happened. Deactivating takes it off
 * the pickers and leaves the history readable.
 */
export function FleetRow({
  record, fields, updateAction, setActiveAction,
}: {
  record: Record_;
  fields: FleetField[];
  updateAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
  setActiveAction: (prev: unknown, fd: FormData) => Promise<ActionResult>;
}) {
  const [editing, setEditing] = useState(false);
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    updateAction as never, null,
  );
  const [activeState, activeFormAction] = useActionState<ActionResult | null, FormData>(
    setActiveAction as never, null,
  );

  // The row stays on screen after saving, so revalidatePath alone would
  // leave the old values under a form that has already closed.
  const router = useRouter();
  useEffect(() => {
    for (const st of [state, activeState]) {
      if (st && "ok" in st) { router.refresh(); return; }
    }
  }, [state, activeState, router]);

  if (editing) {
    return (
      <tr>
        <td colSpan={fields.length + 3}>
          {state && "error" in state && <div className="alert">{state.error}</div>}
          <form
            action={(fd) => { formAction(fd); setEditing(false); }}
            className="form"
          >
            <input type="hidden" name="id" value={record.id} />
            <div className="row">
              {fields.map((f) => (
                <div className="field" key={f.name}>
                  <label htmlFor={`${record.id}-${f.name}`}>{f.label}</label>
                  <input
                    id={`${record.id}-${f.name}`}
                    name={f.name}
                    type="text"
                    defaultValue={String(record[f.name] ?? "")}
                    placeholder={f.placeholder}
                    required={f.required}
                  />
                </div>
              ))}
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
    <tr>
      <td className="code">{record.code}</td>
      {fields.map((f) => (
        <td key={f.name} className="wrap">{String(record[f.name] ?? "—")}</td>
      ))}
      <td className="r">{Number(record.trips) || "—"}</td>
      <td>
        {record.is_active
          ? <span className="pill ok">in service</span>
          : <span className="pill warn">retired</span>}
      </td>
      <td>
        <RowMenu label={`Actions for ${record.code}`}>
          <button type="button" onClick={() => setEditing(true)}>Edit</button>
          <form action={activeFormAction}>
            <input type="hidden" name="id" value={record.id} />
            <input type="hidden" name="active" value={record.is_active ? "0" : "1"} />
            <button type="submit">{record.is_active ? "Retire" : "Bring back"}</button>
          </form>
        </RowMenu>
      </td>
    </tr>
  );
}
