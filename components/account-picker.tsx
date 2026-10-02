"use client";

import { useRouter } from "next/navigation";
import { groupAccountsBySection } from "@/lib/format";
import { ACCOUNT_TYPE_LABEL } from "./account-form";

type Option = {
  id: string; code: string; name: string;
  parent_id?: string | null; account_type?: string;
};
/** Every account including the non-postable headings, so an account's
 *  section can be resolved by walking up to it. */
type TreeNode = {
  id: string; code: string; name: string; parent_id: string | null; is_postable?: boolean;
};

/** Switches which account (or item, or anything code+name) a detail report is showing. */
export function AccountPicker({
  accounts,
  selectedId,
  basePath,
  paramName = "account",
  label = "Account",
  tree = [],
  keep,
  addTo,
  headings = false,
}: {
  accounts: Option[];
  selectedId: string;
  basePath: string;
  paramName?: string;
  label?: string;
  /** Pass the full chart, headings included, to group the list under the same
   *  headings Master data draws. Without it the list stays flat, which is
   *  what every non-account caller of this picker wants. */
  tree?: TreeNode[];
  /** Other query parameters to carry through, so choosing here does not
   *  silently reset a filter set somewhere else on the page. */
  keep?: Record<string, string | undefined>;
  /** The set already being shown. Given one, choosing adds to it rather than
   *  replacing it, and the parameter goes out comma-separated. */
  addTo?: string[];
  /** Offer the non-postable headings too. A heading has no lines of its own,
   *  so it stands for everything beneath it — which is how somebody asks for
   *  "cash" without naming the four accounts that make it up. */
  headings?: boolean;
}) {
  const router = useRouter();

  // Grouped only when a chart was supplied. This picker is also used for
  // items and other code+name lists, and those have no sections to group by.
  const groups = tree.length ? groupAccountsBySection(accounts, tree, ACCOUNT_TYPE_LABEL) : null;

  /* Headings, offered above the accounts. Each one stands for the postable
     accounts under it, so picking "Cash & Bank" asks for all of them at
     once rather than making somebody name each. */
  const headingOptions = headings
    ? tree.filter((t) => t.is_postable === false
        && tree.some((c) => c.parent_id === t.id))
    : [];

  return (
    <div className="row" style={{ maxWidth: 420 }}>
      <div className="field">
        <label htmlFor="acct">{label}</label>
        <select
          id="acct"
          value={selectedId}
          onChange={(e) => {
            const picked = e.target.value;
            if (!picked) return;
            const value = addTo && !addTo.includes(picked)
              ? [...addTo, picked].join(",")
              : picked;
            const q = new URLSearchParams({ [paramName]: value });
            for (const [k, v] of Object.entries(keep ?? {})) if (v) q.set(k, v);
            router.push(`${basePath}?${q.toString()}`);
          }}
        >
          {addTo && <option value="">Choose an account to add…</option>}
          {headingOptions.length > 0 && (
            <optgroup label="Whole sections">
              {headingOptions.map((h) => (
                <option key={h.id} value={h.id}>{h.code} · {h.name} — all of it</option>
              ))}
            </optgroup>
          )}
          {groups
            ? groups.map(([heading, items]) => (
                <optgroup key={heading} label={heading}>
                  {items.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} · {a.name}
                    </option>
                  ))}
                </optgroup>
              ))
            : accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} · {a.name}
                </option>
              ))}
        </select>
      </div>
    </div>
  );
}
