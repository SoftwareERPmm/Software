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
}) {
  const router = useRouter();

  // Grouped only when a chart was supplied. This picker is also used for
  // items and other code+name lists, and those have no sections to group by.
  const groups = tree.length ? groupAccountsBySection(accounts, tree, ACCOUNT_TYPE_LABEL) : null;

  return (
    <div className="row" style={{ maxWidth: 420 }}>
      <div className="field">
        <label htmlFor="acct">{label}</label>
        <select
          id="acct"
          value={selectedId}
          onChange={(e) => router.push(`${basePath}?${paramName}=${e.target.value}`)}
        >
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
