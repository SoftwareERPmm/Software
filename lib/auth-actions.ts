"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { sql } from "./db";
import {
  ROLES, SESSION_COOKIE, SESSION_DAYS, createSession, endSession, hashPassword,
  verifyPassword, passwordProblem, initialsOf, type Role,
} from "./auth";
import { currentUser, requireAccess } from "./session";

export type AuthResult = { error: string } | { ok: true; message?: string } | null;

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/** Five failures in a row, then a quarter of an hour's wait. */
const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

async function setSessionCookie(userId: string) {
  const token = await createSession(userId);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

/** Only a path on this site — never a full URL somebody put in the link. */
function safeNext(next: string): string {
  return next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/login") ? next : "/";
}

export async function signIn(_prev: AuthResult, fd: FormData): Promise<AuthResult> {
  const email = str(fd, "email").toLowerCase();
  const password = String(fd.get("password") ?? "");
  if (!email || !password) return { error: "Enter your email and password." };

  const [u] = await sql`
    select id, password_hash, is_active, failed_logins, must_change_password,
           locked_until > now() as locked,
           ceil(extract(epoch from (locked_until - now())) / 60)::int as minutes_left
      from app_user where lower(email) = ${email}`;

  // One answer for a wrong email and a wrong password, so the form does not
  // tell a stranger which addresses have accounts.
  const wrong = { error: "That email and password do not match." };
  if (!u || !u.is_active || !u.password_hash) return wrong;
  if (u.locked) {
    return { error: `Too many attempts. Try again in ${u.minutes_left} minute${u.minutes_left === 1 ? "" : "s"}.` };
  }

  if (!(await verifyPassword(password, u.password_hash))) {
    const failures = Number(u.failed_logins) + 1;
    await sql`
      update app_user
         set failed_logins = ${failures >= MAX_FAILURES ? 0 : failures},
             locked_until = ${failures >= MAX_FAILURES
               ? sql`now() + make_interval(mins => ${LOCK_MINUTES})` : sql`locked_until`}
       where id = ${u.id}`;
    return failures >= MAX_FAILURES
      ? { error: `Too many attempts. Try again in ${LOCK_MINUTES} minutes.` }
      : wrong;
  }

  await sql`
    update app_user set failed_logins = 0, locked_until = null, last_login_at = now()
     where id = ${u.id}`;
  await setSessionCookie(u.id);
  // Straight to choosing a password, so the address bar says where they are.
  redirect(u.must_change_password ? "/account/password" : safeNext(str(fd, "next")));
}

export async function signOut(): Promise<void> {
  const jar = await cookies();
  await endSession(jar.get(SESSION_COOKIE)?.value);
  jar.delete(SESSION_COOKIE);
  redirect("/login");
}

/**
 * The first administrator, on a database where a company exists and nobody
 * can sign in yet. Refused the moment anyone can — after that, only an
 * administrator adds people.
 */
export async function createFirstAdmin(_prev: AuthResult, fd: FormData): Promise<AuthResult> {
  const name = str(fd, "name");
  const email = str(fd, "email").toLowerCase();
  const password = String(fd.get("password") ?? "");
  if (!name || !email) return { error: "Enter your name and email." };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: "That does not look like an email address." };
  const weak = passwordProblem(password);
  if (weak) return { error: weak };
  if (password !== String(fd.get("confirm") ?? "")) return { error: "The two passwords do not match." };

  const hash = await hashPassword(password);
  const created = await sql.begin(async (tx) => {
    // Serialised, so two people racing the empty screen cannot both win.
    await tx`lock table app_user in share row exclusive mode`;
    const [c] = await tx`select id from company order by created_at limit 1`;
    if (!c) return { error: "Set up the company first." } as const;
    const [{ n }] = await tx`select count(*)::int as n from app_user where password_hash is not null`;
    if (n > 0) return { error: "An administrator already exists. Sign in instead." } as const;
    const [u] = await tx`
      insert into app_user (company_id, name, initials, email, password_hash, roles)
      values (${c.id}, ${name}, ${initialsOf(name)}, ${email}, ${hash}, ${["ADMIN"]})
      on conflict (company_id, name) do update
        set email = excluded.email, password_hash = excluded.password_hash,
            roles = excluded.roles, is_active = true
      returning id`;
    return { id: u.id as string } as const;
  });
  if (!created.id) return { error: created.error ?? "Could not create the administrator." };
  await setSessionCookie(created.id);
  redirect("/");
}

export async function changeOwnPassword(_prev: AuthResult, fd: FormData): Promise<AuthResult> {
  const me = await currentUser();
  if (!me) return { error: "Your session has ended. Sign in again." };
  const current = String(fd.get("current") ?? "");
  const next = String(fd.get("password") ?? "");
  const [u] = await sql`select password_hash from app_user where id = ${me.id}`;
  if (!(await verifyPassword(current, u?.password_hash ?? null))) {
    return { error: "Your current password is not right." };
  }
  const weak = passwordProblem(next);
  if (weak) return { error: weak };
  if (next !== String(fd.get("confirm") ?? "")) return { error: "The two new passwords do not match." };
  if (next === current) return { error: "Choose a password different from the current one." };

  await sql`
    update app_user set password_hash = ${await hashPassword(next)}, must_change_password = false
     where id = ${me.id}`;
  // Every other device signed in as this person is signed out; this one stays.
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? "";
  const { createHash } = await import("node:crypto");
  await sql`
    delete from app_session
     where user_id = ${me.id}
       and token_hash <> ${createHash("sha256").update(token).digest("hex")}`;
  redirect("/?toast=" + encodeURIComponent("Password changed"));
}

// ------------------------------------------------------- managing people --

function rolesFrom(fd: FormData): Role[] {
  return fd.getAll("roles").map(String).filter((r): r is Role => (ROLES as readonly string[]).includes(r));
}

/** Refuse a change that would leave nobody able to manage users. */
async function keepsAnAdmin(changingId: string | null, willBeAdmin: boolean, willBeActive: boolean) {
  if (willBeAdmin && willBeActive) return true;
  const [{ n }] = await sql`
    select count(*)::int as n from app_user
     where is_active and password_hash is not null and 'ADMIN' = any(roles)
       and id is distinct from ${changingId}`;
  return n > 0;
}

export async function createUser(_prev: AuthResult, fd: FormData): Promise<AuthResult> {
  try {
    await requireAccess(["users"]);
    const name = str(fd, "name");
    const email = str(fd, "email").toLowerCase();
    const password = String(fd.get("password") ?? "");
    const roles = rolesFrom(fd);
    if (!name) return { error: "Enter a name." };
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: "Enter a valid email address." };
    if (roles.length === 0) return { error: "Choose at least one role." };
    const weak = passwordProblem(password);
    if (weak) return { error: `Starting password: ${weak}` };

    const [c] = await sql`select id from company order by created_at limit 1`;
    const [taken] = await sql`select 1 from app_user where lower(email) = ${email}`;
    if (taken) return { error: "Someone already signs in with that email." };
    const [sameName] = await sql`select 1 from app_user where company_id = ${c.id} and name = ${name}`;
    if (sameName) return { error: "Someone already has that name. Add a surname or initial." };

    await sql`
      insert into app_user (company_id, name, initials, email, password_hash, roles, must_change_password)
      values (${c.id}, ${name}, ${initialsOf(name)}, ${email}, ${await hashPassword(password)},
              ${roles}, true)`;
    revalidatePath("/settings/users");
    return { ok: true, message: `${name} can now sign in. They will choose their own password first.` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function updateUser(_prev: AuthResult, fd: FormData): Promise<AuthResult> {
  try {
    await requireAccess(["users"]);
    const id = str(fd, "id");
    const name = str(fd, "name");
    const email = str(fd, "email").toLowerCase();
    const roles = rolesFrom(fd);
    const active = fd.get("is_active") !== null;
    if (!name) return { error: "Enter a name." };
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: "Enter a valid email address." };
    if (roles.length === 0) return { error: "Choose at least one role." };
    if (!(await keepsAnAdmin(id, roles.includes("ADMIN"), active))) {
      return { error: "Someone has to remain an active Admin, or nobody could manage users." };
    }
    const [taken] = await sql`select 1 from app_user where lower(email) = ${email} and id <> ${id}`;
    if (taken) return { error: "Someone else already signs in with that email." };

    await sql`
      update app_user
         set name = ${name}, initials = ${initialsOf(name)}, email = ${email},
             roles = ${roles}, is_active = ${active}
       where id = ${id}`;
    // Deactivated people are signed out everywhere at once.
    if (!active) await sql`delete from app_session where user_id = ${id}`;
    revalidatePath("/settings/users");
    return { ok: true, message: `${name} saved.` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function resetUserPassword(_prev: AuthResult, fd: FormData): Promise<AuthResult> {
  try {
    await requireAccess(["users"]);
    const id = str(fd, "id");
    const password = String(fd.get("password") ?? "");
    const weak = passwordProblem(password);
    if (weak) return { error: weak };
    const [u] = await sql`
      update app_user
         set password_hash = ${await hashPassword(password)}, must_change_password = true,
             failed_logins = 0, locked_until = null
       where id = ${id} returning name`;
    if (!u) return { error: "That person no longer exists." };
    await sql`delete from app_session where user_id = ${id}`;
    revalidatePath("/settings/users");
    return { ok: true, message: `Password reset. ${u.name} will choose a new one at sign-in.` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
