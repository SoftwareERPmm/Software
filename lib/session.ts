import { cache } from "react";
import { cookies } from "next/headers";
import { SESSION_COOKIE, userForToken, hasAny, type Module, type SessionUser } from "./auth";

/**
 * The signed-in person for this request, read once and shared by every
 * component and action that asks.
 */
export const currentUser = cache(async (): Promise<SessionUser | null> => {
  const jar = await cookies();
  return userForToken(jar.get(SESSION_COOKIE)?.value);
});

export class NotAllowed extends Error {}

/**
 * Refuse a server action from someone not signed in, or not holding a role
 * that reaches any of `modules`. `[]` means any signed-in person.
 *
 * Outside a request — a test suite or a script calling an action directly —
 * there is no cookie store at all, and nobody to refuse: those run with the
 * database credentials already, which is more than any role grants. Inside a
 * request the check always runs.
 */
export async function requireAccess(modules: readonly Module[]): Promise<SessionUser | null> {
  let jar;
  try {
    jar = await cookies();
  } catch {
    return null;
  }
  const user = await userForToken(jar.get(SESSION_COOKIE)?.value);
  if (!user) throw new NotAllowed("Your session has ended. Sign in again.");
  if (!hasAny(user.roles, modules)) {
    throw new NotAllowed("Your role does not allow this. Ask an administrator for access.");
  }
  return user;
}
