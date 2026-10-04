import {
  getCompany, getBranches, getUnassignedBranchActivity,
  getInventoryCogsReconciliation, UNASSIGNED_BRANCH,
} from "@/lib/queries";

export type Params = { from?: string; to?: string; branch?: string };

const defaultFrom = () => `${new Date().getFullYear()}-01-01`;
const today = () => new Date().toISOString().slice(0, 10);
const n = (v: unknown) => Number(v ?? 0);
const r4 = (v: number) => Math.round(v * 10000) / 10000;

/** A release of stock that was not a sale, named rather than folded in. */
export type Release = {
  key: string; label: string; detail: string; value: number; isCogs: boolean;
};

export async function getInventoryCogsData({ from, to, branch }: Params) {
  const company = await getCompany();
  if (!company) return null;

  const range = { from: from || defaultFrom(), to: to || today() };

  const branches = (await getBranches(company.id)) as unknown as Array<{
    id: string; code: string; name: string; warehouse_count: number;
  }>;
  const unassignedLines = await getUnassignedBranchActivity(company.id);
  const branchId =
    branch === UNASSIGNED_BRANCH ? UNASSIGNED_BRANCH
    : branch && branches.some((b) => b.id === branch) ? branch
    : null;
  const branchName =
    branchId === UNASSIGNED_BRANCH ? "No branch"
    : branches.find((b) => b.id === branchId)?.name ?? "All branches";

  const recon = await getInventoryCogsReconciliation(
    company.id, range.from, range.to, branchId);
  if (!recon) {
    return {
      company, branches, unassignedLines, branchId, branchName, range,
      missing: true as const,
    };
  }

  const opening = n(recon.bal.opening);
  const closing = n(recon.bal.closing);

  /* A movement with one counter-account is named by it; one with several is
     named by the document that made it, because the journal cannot say which
     of its lines the stock belonged to. See getInventoryCogsReconciliation. */
  const nameOf = (m: { code: string | null; name: string | null; source_type: string }) =>
    m.code ? `${m.code} · ${m.name}` : prettyType(m.source_type);

  const additions = recon.movement
    .filter((m) => n(m.into_stock) > 0)
    .map((m) => ({
      key: `${m.account_id ?? "x"}-${m.source_type}-in`,
      label: nameOf(m), detail: prettyType(m.source_type),
      value: r4(n(m.into_stock)), isCogs: false,
    }))
    .sort((a, b) => b.value - a.value);

  const releases: Release[] = recon.movement
    .filter((m) => n(m.out_of_stock) > 0)
    .map((m) => ({
      key: `${m.account_id ?? "x"}-${m.source_type}-out`,
      label: nameOf(m), detail: prettyType(m.source_type),
      value: r4(n(m.out_of_stock)),
      isCogs: m.account_id != null && m.account_id === recon.cogsId,
    }))
    .sort((a, b) => b.value - a.value);

  const addedTotal = r4(additions.reduce((s, a) => s + a.value, 0));
  const releasedTotal = r4(releases.reduce((s, a) => s + a.value, 0));
  const soldCost = r4(releases.filter((x) => x.isCogs).reduce((s, x) => s + x.value, 0));
  const notSold = r4(releasedTotal - soldCost);

  /* The identity the tester checks the books with. It holds — and what it
     equals is everything that left the shelf, not cost of sales, whenever
     stock left for a reason that was not a sale. */
  const formula = r4(opening + addedTotal - closing);
  const formulaTies = formula === releasedTotal;

  /* Two checks that owe each other nothing: the stock ledger's own valuation
     against the account, and the cost it recorded against the cost posted. */
  const fifoValue = r4(n(recon.fifo.value) - n(recon.negative.value));
  const fifoGap = r4(fifoValue - closing);

  /* Stock no longer becomes cost of sales in one move. It leaves inventory
     for 1090 when the goods go, and reaches 5000 when the invoice bills
     them, so there are three accounts and two steps to check rather than
     two accounts and one. */
  const shippedCost = r4(
    recon.consumption
      .filter((c) => c.account_id != null && c.account_id === recon.cogsId)
      .reduce((s, c) => s + n(c.value), 0));

  const held = recon.held;
  const heldIn = r4(n(held?.shipped_in));
  const heldOut = r4(n(held?.invoiced_out));
  const heldClosing = r4(n(held?.closing));
  const heldUnclaimed = r4(n(held?.unclaimed));
  /* What the account holds against what the claims say is unclaimed. The
     two are the same fact counted from opposite ends — the ledger and the
     allocation rows — so a gap means cost reached 1090 by a route nothing
     claimed, or a claim exists for cost that never arrived. */
  const heldGap = r4(heldClosing - heldUnclaimed);
  /* Goods shipped in the period against what the holding account received.
     Both are the delivery's own doing, so they tie unless a delivery moved
     stock without posting, or posted without moving it. */
  const shippedGap = r4(shippedCost - heldIn);

  /* What the claims released, against what cost of sales actually received
     from selling. A customer return credits 5000 as well and is not a claim
     being undone, so it is left out of the right-hand side rather than
     quietly spoiling the comparison. */
  const postedCogs = r4(n(recon.held?.cogs_from_sales));
  const calculatedCogs = heldOut;
  const cogsGap = r4(calculatedCogs - postedCogs);

  return {
    company, branches, unassignedLines, branchId, branchName, range,
    missing: false as const,
    opening, closing, additions, releases,
    addedTotal, releasedTotal, soldCost, notSold, formula, formulaTies,
    fifoValue, fifoGap, lots: recon.fifo.lots,
    negativeValue: r4(n(recon.negative.value)), negativeQty: r4(n(recon.negative.qty)),
    calculatedCogs, postedCogs, cogsGap,
    shippedCost, heldIn, heldOut, heldClosing, heldUnclaimed, heldGap, shippedGap,
  };
}

function prettyType(t: string) {
  return ({
    GOODS_RECEIPT: "Goods received",
    PURCHASE_INVOICE: "Purchase invoice",
    PURCHASE_RETURN: "Returned to supplier",
    DELIVERY: "Delivered",
    SALES_RETURN: "Returned by customer",
    STOCK_ADJUSTMENT: "Stock adjustment",
    STOCK_TRANSFER: "Transfer between warehouses",
    OPENING_BALANCE: "Opening balance",
  } as Record<string, string>)[t] ?? t.toLowerCase().replace(/_/g, " ");
}
