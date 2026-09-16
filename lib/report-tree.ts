/**
 * A financial statement, shaped the way the chart of accounts already is.
 *
 * The statements listed every postable account flat under its type, which
 * discards structure the chart has carried all along: 4000 Sales and 4100
 * Other Income both hang from 4-SA, and Selling and Administration expenses
 * are separate groups under 6-EX. Reading "what did administration cost" meant
 * adding the rows up by eye.
 *
 * Nothing here decides an amount. Postable accounts carry the figures the
 * ledger returned; a group's figure is the sum of what is beneath it, so a
 * subtotal can never disagree with its own rows. Groups with nothing under
 * them in the period are dropped — a chart has accounts a business may never
 * use, and a statement listing them says the company did something it did not.
 */

export type ChartRow = {
  id: string;
  code: string;
  name: string;
  parent_id: string | null;
  account_type: string;
  is_postable: boolean;
};

export type StatementNode = {
  id: string;
  code: string;
  name: string;
  /** Rolled up from children for a group; as posted for a leaf. */
  amount: number;
  /** 0 for a top-level group under the section heading. */
  depth: number;
  postable: boolean;
  children: StatementNode[];
};

/**
 * @param chart every account in the company, postable or not
 * @param amounts what the ledger returned, keyed by account id
 * @param types which account types belong in this section
 */
export function buildStatement(
  chart: ChartRow[],
  amounts: Map<string, number>,
  types: string[],
): { nodes: StatementNode[]; total: number } {
  const wanted = new Set(types);
  const byParent = new Map<string | null, ChartRow[]>();
  for (const a of chart) {
    if (!wanted.has(a.account_type)) continue;
    const list = byParent.get(a.parent_id) ?? [];
    list.push(a);
    byParent.set(a.parent_id, list);
  }

  const build = (row: ChartRow, depth: number): StatementNode | null => {
    const kids = (byParent.get(row.id) ?? [])
      .map((k) => build(k, depth + 1))
      .filter((k): k is StatementNode => k !== null);

    const own = amounts.get(row.id) ?? 0;
    // A posting on a group account is unusual but legal, so it is added
    // rather than assumed away — dropping it would lose money from a total.
    const amount = kids.reduce((t, k) => t + k.amount, 0) + own;

    if (kids.length === 0 && !amounts.has(row.id)) return null;
    return {
      id: row.id, code: row.code, name: row.name,
      amount, depth, postable: row.is_postable, children: kids,
    };
  };

  /**
   * Roots are accounts whose parent is outside this section — which covers
   * both a true top-level account and one orphaned by a parent of another
   * type, rather than silently dropping the second kind.
   */
  const inSection = new Set(chart.filter((a) => wanted.has(a.account_type)).map((a) => a.id));
  const roots = chart.filter(
    (a) => wanted.has(a.account_type) && (!a.parent_id || !inSection.has(a.parent_id)),
  );

  const nodes = roots
    .map((r) => build(r, 0))
    .filter((n): n is StatementNode => n !== null);

  return { nodes, total: nodes.reduce((t, n) => t + n.amount, 0) };
}

/** Flattened depth-first, which is what a table body and a CSV both want. */
export function flatten(nodes: StatementNode[]): StatementNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}
