import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, userForToken, canSeePath } from "@/lib/auth";

/**
 * Every page request is checked here, typed URLs included.
 *
 * Not signed in: to the sign-in page, remembering where they were going.
 * Signed in without a role that reaches the page: the page is replaced by
 * "You don't have access", with a 403, at the URL they asked for — the
 * address bar keeps saying what they tried, and the response says no.
 *
 * Runs on Node rather than the edge so it can read the session from the
 * database with the same client everything else uses.
 */
export const config = {
  runtime: "nodejs",
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:png|jpg|jpeg|svg|webp|ico|woff2?)$).*)",
  ],
};

const OPEN = ["/login", "/setup"];

export async function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  // The layout cannot see the URL on its own; it needs it to know whether to
  // draw the app around a page or leave the sign-in screen bare.
  const headers = new Headers(req.headers);
  headers.set("x-pathname", path);
  const pass = () => NextResponse.next({ request: { headers } });

  if (OPEN.some((p) => path === p || path.startsWith(p + "/"))) return pass();

  const user = await userForToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (!user) {
    const to = new URL("/login", req.url);
    if (path !== "/") to.searchParams.set("next", path + req.nextUrl.search);
    const res = NextResponse.redirect(to);
    if (req.cookies.has(SESSION_COOKIE)) res.cookies.delete(SESSION_COOKIE);
    return res;
  }

  // A password the administrator set is theirs until it is changed.
  if (user.mustChangePassword && path !== "/account/password" && path !== "/logout") {
    return NextResponse.redirect(new URL("/account/password", req.url));
  }

  if (!canSeePath(user.roles, path)) {
    headers.set("x-forbidden", "1");
    return NextResponse.rewrite(new URL("/forbidden", req.url), { status: 403, request: { headers } });
  }

  return pass();
}
