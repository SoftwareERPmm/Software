"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";

/**
 * The second supplier on the chart, chosen where the chart is.
 *
 * Comparison already worked — every row of the table carried a "compare"
 * link — but it was thirteen-pixel grey text under a supplier code, with
 * nothing anywhere saying the feature existed. People did not fail to use
 * it, they failed to find it, which is the same outcome and a worse reason.
 *
 * A select beside the chart title advertises it instead: you can see that
 * two suppliers can be shown before you have worked out how. The row links
 * stay, because once you know, clicking the row you are already reading is
 * faster than finding it again in a list.
 *
 * Two at a time and no more. A third filled polygon over the first two
 * stops being readable, and a radar that cannot be read is worse than a
 * table that can.
 */
export function ComparePicker({
  suppliers, selectedId, compareId,
}: {
  /** Everyone on the report, in the order the table shows them. */
  suppliers: { id: string; name: string }[];
  selectedId: string;
  compareId: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const go = (id: string) => {
    const p = new URLSearchParams(params.toString());
    if (id) p.set("compare", id);
    else p.delete("compare");
    router.push(`${pathname}?${p.toString()}`);
  };

  const others = suppliers.filter((s) => s.id !== selectedId);
  if (others.length === 0) return null;

  return (
    <label className="comparepick">
      <span className="page-sub">Compare with</span>
      <select value={compareId ?? ""} onChange={(e) => go(e.target.value)}>
        <option value="">nobody</option>
        {others.map((s) => (
          <option key={s.id} value={s.id}>{s.name}</option>
        ))}
      </select>
    </label>
  );
}
