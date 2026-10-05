"use client";

import { useActionState, useEffect, useState, startTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createUser, updateUser, resetUserPassword, type AuthResult } from "@/lib/auth-actions";

export type RoleOption = { value: string; label: string; hint: string };
export type UserRecord = {
  id: string; name: string; email: string | null; roles: string[]; is_active: boolean;
  last_login_at: string | null; must_change_password: boolean; is_me: boolean;
};

/**
 * Submit without React's automatic form reset, which would throw away what
 * the administrator typed whenever the server refuses it. The add form is
 * cleared on purpose, after a success, by remounting it.
 */
function keep(action: (fd: FormData) => void) {
  return (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startTransition(() => action(fd));
  };
}

function Result({ state }: { state: AuthResult }) {
  if (!state) return null;
  if ("error" in state) return <div className="alert">{state.error}</div>;
  return state.message ? <div className="notice ok">{state.message}</div> : null;
}

function RolePicker({ options, chosen }: { options: RoleOption[]; chosen?: string[] }) {
  return (
    <fieldset className="role-pick">
      <legend>Roles</legend>
      {options.map((o) => (
        <label key={o.value} className="role-opt">
          <input type="checkbox" name="roles" value={o.value} defaultChecked={chosen?.includes(o.value)} />
          <span>
            <strong>{o.label}</strong>
            <span>{o.hint}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export function NewUserForm({ roles }: { roles: RoleOption[] }) {
  const [state, action, pending] = useActionState<AuthResult, FormData>(createUser, null);
  const [key, setKey] = useState(0);
  // A fresh form after each person added, so the next one starts blank.
  useEffect(() => { if (state && "ok" in state) setKey((k) => k + 1); }, [state]);
  return (
    <section className="card">
      <div className="card-head"><h2>Add a person</h2></div>
      <form key={key} onSubmit={keep(action)} className="card-body user-form">
        <div className="user-grid">
          <div className="field"><label htmlFor="nu-name">Name</label>
            <input id="nu-name" name="name" type="text" required /></div>
          <div className="field"><label htmlFor="nu-email">Email</label>
            <input id="nu-email" name="email" type="email" required autoComplete="off" /></div>
          <div className="field"><label htmlFor="nu-pw">Starting password</label>
            <input id="nu-pw" name="password" type="text" required autoComplete="new-password" minLength={8} />
            <span className="hint">Tell them this once. They choose their own at first sign-in.</span></div>
        </div>
        <RolePicker options={roles} />
        <Result state={state} />
        <div className="actions"><button className="btn" disabled={pending}>{pending ? "Adding…" : "Add person"}</button></div>
      </form>
    </section>
  );
}

export function UserRow({ user, roles, roleLabel }: {
  user: UserRecord; roles: RoleOption[]; roleLabel: Record<string, string>;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "reset">("view");
  const [state, action, pending] = useActionState<AuthResult, FormData>(updateUser, null);
  const [rState, rAction, rPending] = useActionState<AuthResult, FormData>(resetUserPassword, null);
  const router = useRouter();
  useEffect(() => {
    if ((state && "ok" in state) || (rState && "ok" in rState)) { setMode("view"); router.refresh(); }
  }, [state, rState, router]);

  const seen = user.last_login_at
    ? new Date(user.last_login_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
    : "Never";

  return (
    <>
      <tr className={user.is_active ? undefined : "muted-row"}>
        <td>
          <strong>{user.name}</strong>{user.is_me && <span className="pill">You</span>}
          {!user.is_active && <span className="pill">Inactive</span>}
          <div className="sub">{user.email}</div>
        </td>
        <td>{user.roles.map((r) => roleLabel[r] ?? r).join(", ")}</td>
        <td>{seen}{user.must_change_password && <div className="sub">Must choose a password</div>}</td>
        <td className="r">
          <button type="button" className="btn ghost sm" onClick={() => setMode(mode === "edit" ? "view" : "edit")}>Edit</button>{" "}
          <button type="button" className="btn ghost sm" onClick={() => setMode(mode === "reset" ? "view" : "reset")}>Reset password</button>
        </td>
      </tr>
      {mode === "edit" && (
        <tr><td colSpan={4}>
          <form onSubmit={keep(action)} className="user-form inline">
            <input type="hidden" name="id" value={user.id} />
            <div className="user-grid">
              <div className="field"><label>Name</label><input name="name" type="text" defaultValue={user.name} required /></div>
              <div className="field"><label>Email</label><input name="email" type="email" defaultValue={user.email ?? ""} required /></div>
              <label className="role-opt solo">
                <input type="checkbox" name="is_active" defaultChecked={user.is_active} disabled={user.is_me} />
                <span><strong>Can sign in</strong><span>Untick to sign them out everywhere and block sign-in.</span></span>
                {user.is_me && <input type="hidden" name="is_active" value="on" />}
              </label>
            </div>
            <RolePicker options={roles} chosen={user.roles} />
            <Result state={state} />
            <div className="actions">
              <button className="btn" disabled={pending}>{pending ? "Saving…" : "Save"}</button>
              <button type="button" className="btn ghost" onClick={() => setMode("view")}>Cancel</button>
            </div>
          </form>
        </td></tr>
      )}
      {mode === "reset" && (
        <tr><td colSpan={4}>
          <form onSubmit={keep(rAction)} className="user-form inline">
            <input type="hidden" name="id" value={user.id} />
            <div className="user-grid">
              <div className="field"><label>New starting password</label>
                <input name="password" type="text" required minLength={8} autoComplete="new-password" />
                <span className="hint">Signs them out everywhere. They choose their own at next sign-in.</span></div>
            </div>
            <Result state={rState} />
            <div className="actions">
              <button className="btn" disabled={rPending}>{rPending ? "Resetting…" : "Reset password"}</button>
              <button type="button" className="btn ghost" onClick={() => setMode("view")}>Cancel</button>
            </div>
          </form>
        </td></tr>
      )}
    </>
  );
}
