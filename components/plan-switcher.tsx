"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import type { ActionResult } from "@/lib/actions";
import type { Plan, PlanLimits } from "@/lib/plans";

const ORDER: Plan[] = ["STARTER", "BUSINESS", "ENTERPRISE"];

const BLURB: Record<Plan, string> = {
  STARTER: "Small shops and simple trading",
  BUSINESS: "Growing SMEs",
  ENTERPRISE: "Large distributors and field sales",
};

/**
 * Switching the package, and showing what each one allows.
 *
 * A limit nobody has decided shows as "not decided" rather than as a dash or
 * an infinity sign. Both of those read as answers; this is an open question,
 * and the screen should not quietly close it.
 *
 * What the company already holds is shown beside each limit, because the
 * interesting thing about a limit is whether you are over it — and on both
 * live databases the branch count already exceeds Starter's.
 */
export function PlanSwitcher({
  current, limits, have, action,
}: {
  current: Plan;
  limits: Record<Plan, PlanLimits>;
  have: { branches: number; warehouses: number };
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
}) {
  const [state, formAction, working] = useActionState<ActionResult | null, FormData>(
    action as never, null,
  );

  const router = useRouter();
  useEffect(() => {
    if (state && "ok" in state) router.refresh();
  }, [state, router]);

  const cell = (limit: number | null, held: number) => {
    if (limit === null) {
      return <span style={{ color: "var(--muted)" }}>not decided</span>;
    }
    const over = held > limit;
    return (
      <>
        <strong style={{ color: over ? "var(--warn)" : undefined }}>{limit}</strong>
        <div className="subline">
          {held} in use{over && " — over this limit"}
        </div>
      </>
    );
  };

  return (
    <>
      {state && "error" in state && <div className="alert">{state.error}</div>}

      <section>
        <div className="card">
          <div className="card-head">
            <h2>Packages</h2>
            <span className="page-sub">
              on <strong>{current.charAt(0) + current.slice(1).toLowerCase()}</strong>
              {" · nothing enforced yet"}
            </span>
          </div>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Package</th>
                  <th className="r">Branches</th>
                  <th className="r">Warehouses</th>
                  <th className="r">Users</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {ORDER.map((p) => {
                  const l = limits[p];
                  const here = p === current;
                  return (
                    <tr key={p}>
                      <td className="wrap">
                        <strong>{p.charAt(0) + p.slice(1).toLowerCase()}</strong>
                        {here && <span className="pill ok" style={{ marginLeft: "0.4rem" }}>current</span>}
                        <div className="subline">{BLURB[p]}</div>
                      </td>
                      <td className="r">{cell(l.branches, have.branches)}</td>
                      <td className="r">{cell(l.warehouses, have.warehouses)}</td>
                      <td className="r">
                        {l.users === null
                          ? <span style={{ color: "var(--muted)" }}>not decided</span>
                          : l.users}
                      </td>
                      <td className="r">
                        {here ? (
                          <span className="page-sub">—</span>
                        ) : (
                          <form action={formAction}>
                            <input type="hidden" name="plan" value={p} />
                            <button type="submit" className="btn ghost" disabled={working}>
                              Switch
                            </button>
                          </form>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section>
        <div className="card">
          <div className="card-body">
            <div className="hintbar caution">
              <strong>Switching changes nothing today.</strong> No screen is
              hidden and no limit refuses anything — the column exists so the
              tiers can be built against it. When enforcement does arrive, a
              company already over a limit keeps what it has and is refused
              only on adding more: nothing already posted or configured should
              be invalidated by a change to a price list.
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
