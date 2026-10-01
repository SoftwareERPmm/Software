"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { ActionResult } from "@/lib/actions";
import { METRICS, type MetricId } from "@/lib/supplier-metrics";
import { shortDate } from "@/lib/format";
import { HelpHint } from "./help-hint";

/**
 * Saved radar layouts, managed away from the chart that uses them.
 *
 * Creating one happens on the dashboard, where the axes being saved are on
 * screen and can be seen. Deleting one happens here, because deleting the
 * chart you are looking at from underneath yourself is disorienting, and
 * because a destructive action belongs somewhere deliberate.
 */
export function PresetList({
  presets, action,
}: {
  presets: { id: string; name: string; axes: string[]; is_default: boolean;
             updated_at: string }[];
  action: (prev: unknown, fd: FormData) => Promise<ActionResult>;
}) {
  const router = useRouter();
  const [state, formAction, pending] =
    useActionState<ActionResult | null, FormData>(action as never, null);

  useEffect(() => { if (state && "ok" in state) router.refresh(); }, [state, router]);

  return (
    <section>
      <div className="card">
        <div className="card-head">
          <div className="headwith">
            <h2>Saved radar layouts</h2>
            <HelpHint label="What a preset is">
              A view of the same measurements, never a different calculation
              of them. Purchasing and quality want different charts from one
              set of figures, and both are right. The order is saved with the
              selection, because a radar&rsquo;s shape changes entirely with
              the order of its spokes.
            </HelpHint>
          </div>
        </div>

        {state && "error" in state && <div className="alert">{state.error}</div>}

        {presets.length === 0 ? (
          <div className="card-body">
            <p className="page-sub">
              None saved. Choose the axes you want on the{" "}
              <Link href="/purchases/supplier-performance">dashboard</Link> and
              save them there, where you can see what you are naming.
            </p>
          </div>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Axes, in order</th>
                  <th>Changed</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {presets.map((p) => (
                  <tr key={p.id}>
                    <td className="wrap">
                      <strong>{p.name}</strong>
                      {p.is_default && <span className="pill ok">opens by default</span>}
                    </td>
                    <td className="wrap">
                      <ol className="preset-axes">
                        {p.axes.map((a) => (
                          <li key={a}>
                            {METRICS[a as MetricId]?.name ?? a}
                          </li>
                        ))}
                      </ol>
                    </td>
                    <td className="page-sub">{shortDate(p.updated_at)}</td>
                    <td>
                      <div style={{ display: "flex", gap: "0.4rem" }}>
                        <Link className="ghost"
                              href={`/purchases/supplier-performance?axes=${p.axes.join(",")}`}>
                          Open
                        </Link>
                        <form action={formAction}>
                          <input type="hidden" name="id" value={p.id} />
                          <button type="submit" className="ghost" disabled={pending}>
                            Delete
                          </button>
                        </form>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
