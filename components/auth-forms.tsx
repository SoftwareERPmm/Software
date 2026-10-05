"use client";

import { useActionState, useState, type KeyboardEvent } from "react";
import { Eye, EyeOff, ArrowRight } from "lucide-react";
import { signIn, createFirstAdmin, changeOwnPassword, type AuthResult } from "@/lib/auth-actions";

/**
 * A password box with the two things people actually need from one: a way
 * to see what they typed, and a warning before Caps Lock costs them an
 * attempt — this form locks after five.
 */
function PasswordField({
  name, label, autoComplete, autoFocus, hint,
}: {
  name: string; label: string; autoComplete: string; autoFocus?: boolean; hint?: string;
}) {
  const [shown, setShown] = useState(false);
  const [caps, setCaps] = useState(false);
  const watch = (e: KeyboardEvent<HTMLInputElement>) => setCaps(e.getModifierState?.("CapsLock") ?? false);
  return (
    <div className="auth-field">
      <label htmlFor={name}>{label}</label>
      <div className="auth-pass">
        <input
          id={name} name={name} type={shown ? "text" : "password"} required
          autoComplete={autoComplete} autoFocus={autoFocus}
          onKeyDown={watch} onKeyUp={watch} onBlur={() => setCaps(false)}
          aria-describedby={caps ? `${name}-caps` : hint ? `${name}-hint` : undefined}
        />
        <button
          type="button" className="auth-eye" onClick={() => setShown((v) => !v)}
          aria-label={shown ? "Hide password" : "Show password"} aria-pressed={shown}
        >
          {shown ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
        </button>
      </div>
      {caps
        ? <span id={`${name}-caps`} className="auth-note warn" role="status">Caps Lock is on</span>
        : hint ? <span id={`${name}-hint`} className="auth-note">{hint}</span> : null}
    </div>
  );
}

function Problem({ state }: { state: AuthResult }) {
  if (!state || !("error" in state)) return null;
  return <p className="auth-error" role="alert">{state.error}</p>;
}

export function SignInForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<AuthResult, FormData>(signIn, null);
  // Held here, because React clears a form after it submits: a mistyped
  // password must not cost the person their email as well.
  const [email, setEmail] = useState("");
  return (
    <form action={action} className="auth-form">
      <input type="hidden" name="next" value={next} />
      <div className="auth-field">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" required autoComplete="username"
               autoFocus inputMode="email" spellCheck={false}
               value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <PasswordField name="password" label="Password" autoComplete="current-password" />
      <Problem state={state} />
      <button type="submit" className="auth-submit" disabled={pending}>
        {pending ? "Signing in…" : <>Sign in <ArrowRight size={16} aria-hidden="true" /></>}
      </button>
      <p className="auth-aside">Forgot your password? Your administrator can reset it.</p>
    </form>
  );
}

export function FirstAdminForm() {
  const [state, action, pending] = useActionState<AuthResult, FormData>(createFirstAdmin, null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  return (
    <form action={action} className="auth-form">
      <div className="auth-field">
        <label htmlFor="name">Your name</label>
        <input id="name" name="name" type="text" required autoComplete="name" autoFocus
               value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="auth-field">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" required autoComplete="username"
               inputMode="email" spellCheck={false}
               value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <PasswordField name="password" label="Password" autoComplete="new-password"
                     hint="At least 8 characters" />
      <PasswordField name="confirm" label="Confirm password" autoComplete="new-password" />
      <Problem state={state} />
      <button type="submit" className="auth-submit" disabled={pending}>
        {pending ? "Creating…" : <>Create administrator <ArrowRight size={16} aria-hidden="true" /></>}
      </button>
    </form>
  );
}

export function ChangePasswordForm({ forced }: { forced: boolean }) {
  const [state, action, pending] = useActionState<AuthResult, FormData>(changeOwnPassword, null);
  return (
    <form action={action} className="auth-form">
      <PasswordField name="current" label={forced ? "Password you were given" : "Current password"}
                     autoComplete="current-password" autoFocus />
      <PasswordField name="password" label="New password" autoComplete="new-password"
                     hint="At least 8 characters" />
      <PasswordField name="confirm" label="Confirm new password" autoComplete="new-password" />
      <Problem state={state} />
      <button type="submit" className="auth-submit" disabled={pending}>
        {pending ? "Saving…" : "Save password"}
      </button>
    </form>
  );
}
