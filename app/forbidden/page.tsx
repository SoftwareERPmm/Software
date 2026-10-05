import Link from "next/link";
import { headers } from "next/headers";
import { ShieldAlert } from "lucide-react";
import { currentUser } from "@/lib/session";
import { ROLE_LABEL, modulesForPath } from "@/lib/auth";

export const metadata = { title: "No access · Myanmar ERP" };

const MODULE_LABEL = {
  sales: "Sales", purchasing: "Purchasing", inventory: "Inventory",
  accounting: "Accounting & Finance", users: "Admin",
} as const;

/**
 * What middleware shows in place of a page the person's roles do not reach,
 * at the URL they asked for. Says which role would open it, so the request
 * to an administrator can be specific.
 */
export default async function Forbidden() {
  const me = await currentUser();
  const asked = (await headers()).get("x-pathname") ?? "";
  const needs = modulesForPath(asked).map((m) => MODULE_LABEL[m]);
  return (
    <div className="gate">
      <div className="gate-panel">
        <span className="gate-code"><ShieldAlert size={16} aria-hidden="true" /> No access</span>
        <h1>This page is outside your role</h1>
        <p>
          {needs.length > 0
            ? <>It needs the {needs.join(" or ")} role{needs.length > 1 ? "s" : ""}. </>
            : null}
          {me
            ? <>You are signed in as {me.name} with {me.roles.map((r) => ROLE_LABEL[r]).join(", ") || "no roles"}.
                {" "}An administrator can change that from Users &amp; roles.</>
            : null}
        </p>
        <div className="gate-actions">
          <Link href="/" className="btn">Go to the dashboard</Link>
        </div>
      </div>
    </div>
  );
}
