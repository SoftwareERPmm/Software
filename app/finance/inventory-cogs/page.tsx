import Link from "next/link";
import { money } from "@/lib/db";
import { AutoApply } from "@/components/auto-apply";
import { UNASSIGNED_BRANCH } from "@/lib/queries";
import { HelpHint } from "@/components/help-hint";
import { getInventoryCogsData, type Params } from "./data";

const fmt = (v: number) => money(String(v));

export default async function InventoryCogs({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const data = await getInventoryCogsData(await searchParams);
  if (!data) return <div className="empty">No company found.</div>;
  const { company, branches, unassignedLines, branchId, range } = data;

  const q = (extra: Record<string, string>) => ({
    from: range.from, to: range.to,
    ...(branchId ? { branch: branchId } : {}), ...extra,
  });

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Accounting · Financial Reports</span>
        <h1>Inventory &amp; cost of sales</h1>
        <HelpHint label="Why this report exists">
          Cost of sales here is not calculated at the period end. Stock is
          valued FIFO and the cost of each sale is recognised as the goods
          leave, from the layers they actually came from &mdash; so a purchase
          never reaches the income statement at all, it becomes inventory.
          <br /><br />
          The familiar <em>opening + purchases &minus; closing</em> still
          holds, and this report shows it holding. What it also shows is the
          part that calculation hides: stock leaves for reasons that are not
          sales &mdash; a giveaway, a write-off, goods going back to a
          supplier &mdash; and every one of those satisfies the formula while
          being nothing to do with cost of goods sold.
          <br /><br />
          Where the two sides disagree the difference is shown as a
          difference. Nothing here is balanced by a plug.
        </HelpHint>
      </div>

      <form className="row" style={{ marginBottom: "1rem", alignItems: "flex-end" }}>
        <div className="field">
          <label htmlFor="branch">Branch</label>
          <select id="branch" name="branch" defaultValue={branchId ?? ""}>
            <option value="">All branches (consolidated)</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.code} · {b.name}</option>
            ))}
            {unassignedLines.lines > 0 && (
              <option value={UNASSIGNED_BRANCH}>— No branch ({unassignedLines.lines} lines) —</option>
            )}
          </select>
        </div>
        <div className="field">
          <label htmlFor="from">From</label>
          <input id="from" name="from" type="date" defaultValue={range.from} />
        </div>
        <div className="field">
          <label htmlFor="to">To</label>
          <input id="to" name="to" type="date" defaultValue={range.to} />
        </div>
        <div className="actions">
          <AutoApply />
          <button type="submit" data-apply>Update</button>
        </div>
      </form>

      {data.missing ? (
        <div className="empty">
          No inventory account is configured, so there is nothing to
          reconcile. Set the INVENTORY role under Master data → Chart of
          accounts.
        </div>
      ) : (
        <>
          <div className="kpis">
            <Tile label="Opening inventory" value={fmt(data.opening)}
                  sub={`as at ${range.from}`} />
            <Tile label="Closing inventory" value={fmt(data.closing)}
                  sub={`as at ${range.to}`} />
            <Tile label="Cost of goods sold" value={fmt(data.soldCost)}
                  sub="the part that was sold" />
            <Tile label="Left for other reasons" value={fmt(data.notSold)}
                  sub={data.notSold === 0 ? "none" : "not cost of sales"} />
          </div>

          <section>
            <div className="card">
              <div className="card-head">
                <div className="headwith">
                  <h2>Opening + additions &minus; closing</h2>
                  <HelpHint label="What this proves">
                    The identity holds by construction: every movement through
                    the inventory account is counted once. What it equals is
                    everything that left the shelf &mdash; which is cost of
                    sales only when nothing else happened.
                  </HelpHint>
                </div>
                <span className="page-sub">
                  {data.formulaTies ? "ties exactly" : "does not tie"}
                </span>
              </div>
              <div className="tablewrap">
                <table>
                  <tbody>
                    <tr>
                      <td>Opening inventory</td>
                      <td className="r">{fmt(data.opening)}</td>
                    </tr>
                    {data.additions.map((a) => (
                      <tr key={a.key}>
                        <td style={{ paddingLeft: "1.5rem" }}>
                          + {a.label}
                          {a.label !== a.detail && <div className="subline">{a.detail}</div>}
                        </td>
                        <td className="r">{fmt(a.value)}</td>
                      </tr>
                    ))}
                    <tr>
                      <td><strong>Additions</strong></td>
                      <td className="r"><strong>{fmt(data.addedTotal)}</strong></td>
                    </tr>
                    <tr>
                      <td>&minus; Closing inventory</td>
                      <td className="r">{fmt(data.closing)}</td>
                    </tr>
                  </tbody>
                  <tfoot>
                    <tr>
                      <td><strong>= Cost of inventory released</strong></td>
                      <td className="r"><strong>{fmt(data.formula)}</strong></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          </section>

          <section>
            <div className="card">
              <div className="card-head">
                <div className="headwith">
                  <h2>What left the shelf, and why</h2>
                  <HelpHint label="Why this matters">
                    This is the line the traditional calculation cannot draw.
                    A promotional giveaway credits inventory and debits
                    promotion expense; a write-off debits inventory
                    adjustment. Both are &ldquo;opening plus purchases less
                    closing&rdquo; and neither is cost of goods sold, so
                    counting them as such overstates it by exactly their
                    value.
                  </HelpHint>
                </div>
                <span className="page-sub">{fmt(data.releasedTotal)} in total</span>
              </div>
              <div className="tablewrap">
                <table>
                  <thead>
                    <tr><th>Charged to</th><th>Kind</th><th className="r">Value</th><th /></tr>
                  </thead>
                  <tbody>
                    {data.releases.length === 0 ? (
                      <tr><td colSpan={4} className="empty">Nothing left the shelf in this period.</td></tr>
                    ) : data.releases.map((rl) => (
                      <tr key={rl.key}>
                        <td className="wrap">
                          {rl.label}
                          {rl.isCogs && <> <span className="pill ok">cost of sales</span></>}
                        </td>
                        <td className="page-sub">{rl.detail}</td>
                        <td className="r">{fmt(rl.value)}</td>
                        <td>
                          <Link className="subline"
                                href={{ pathname: "/inventory/movements", query: q({}) }}>
                            movements
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={2}><strong>Cost of goods sold</strong></td>
                      <td className="r"><strong>{fmt(data.soldCost)}</strong></td>
                      <td />
                    </tr>
                    <tr>
                      <td colSpan={2}>Left for other reasons</td>
                      <td className="r">{fmt(data.notSold)}</td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          </section>

          <section className="grid2">
            <Check
              title="Stock ledger against the account"
              left="FIFO value of what is on the shelf" leftValue={fmt(data.fifoValue)}
              right="Inventory account" rightValue={fmt(data.closing)}
              gap={data.fifoGap}
              note={
                data.negativeQty !== 0
                  ? `Includes ${fmt(data.negativeValue)} of goods issued before they were received `
                    + `(${data.negativeQty} units), carried at a provisional cost until the receipt arrives.`
                  : `Across ${data.lots} open layer${data.lots === 1 ? "" : "s"}. `
                    + `Consigned goods are in neither figure — they are not yours to value.`
              }
              href={{ pathname: "/inventory/intelligence", query: q({ tab: "aging" }) }}
              hrefLabel="inventory aging"
            />
            <Check
              title="Cost released against cost posted"
              left="Released from 1090 by invoices" leftValue={fmt(data.calculatedCogs)}
              right="Posted to cost of sales" rightValue={fmt(data.postedCogs)}
              gap={data.cogsGap}
              note={
                "Cost of sales is recognised by the invoice that bills the "
                + "goods, so every credit to 1090 is a debit to 5000 in the "
                + "same entry. Returns credit cost of sales and are netted "
                + "off the posted side."
              }
              href={{ pathname: "/finance/general-ledger", query: q({}) }}
              hrefLabel="general ledger"
            />
          </section>

          {/* The step that did not exist before: goods leave inventory, wait
              in the holding account, and reach cost of sales when somebody
              bills them. Shown as the three movements it is, because a month
              that shipped more than it billed otherwise looks like inventory
              that went nowhere. */}
          <section>
            <div className="card">
              <div className="card-head">
                <h2>Inventory &rarr; shipped not invoiced &rarr; cost of sales</h2>
                <span className="page-sub">{data.range.from} to {data.range.to}</span>
              </div>
              <div className="card-body">
                <div className="kpis">
                  <Tile label="Shipped into 1090" value={fmt(data.heldIn)}
                        sub="cost of goods that left in the period" />
                  <Tile label="Released to cost of sales" value={fmt(data.heldOut)}
                        sub="claimed by the invoices that billed them" />
                  <Tile label="Still held at 1090" value={fmt(data.heldClosing)}
                        sub="shipped, nobody billed yet" />
                </div>
              </div>
            </div>
          </section>

          <section className="grid2">
            <Check
              title="Goods shipped against the holding account"
              left="Layers consumed by deliveries" leftValue={fmt(data.shippedCost)}
              right="Debited to 1090" rightValue={fmt(data.heldIn)}
              gap={data.shippedGap}
              note={
                "Both are the delivery's own doing — the stock ledger says "
                + "what left and the journal says what it cost — so they tie "
                + "unless a delivery moved stock without posting, or posted "
                + "without moving it. Giveaways are in neither: their cost "
                + "goes straight to the reason's own account."
              }
              href={{ pathname: "/finance/general-ledger", query: q({}) }}
              hrefLabel="general ledger"
            />
            <Check
              title="The holding account against what is unclaimed"
              left="Balance of 1090" leftValue={fmt(data.heldClosing)}
              right="Delivered cost no invoice has claimed" rightValue={fmt(data.heldUnclaimed)}
              gap={data.heldGap}
              note={
                "The same fact counted from opposite ends: what the ledger "
                + "holds, and what the claim rows say is still unspoken for. "
                + "A gap means cost reached the account by a route nothing "
                + "claimed, or a claim exists for cost that never arrived."
              }
              href={{ pathname: "/finance/shipped-not-invoiced", query: {} }}
              hrefLabel="shipped not invoiced"
            />
          </section>
        </>
      )}
    </>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-note">{sub}</div>
    </div>
  );
}

function Check({
  title, left, leftValue, right, rightValue, gap, note, href, hrefLabel,
}: {
  title: string; left: string; leftValue: string; right: string; rightValue: string;
  gap: number; note: string;
  href: { pathname: string; query: Record<string, string> }; hrefLabel: string;
}) {
  return (
    <div className="card">
      <div className="card-head">
        <h2>{title}</h2>
        <span className="page-sub">
          {gap === 0
            ? "agrees"
            : <strong style={{ color: "var(--bad)" }}>differs by {money(String(gap))}</strong>}
        </span>
      </div>
      <div className="tablewrap">
        <table>
          <tbody>
            <tr><td>{left}</td><td className="r">{leftValue}</td></tr>
            <tr><td>{right}</td><td className="r">{rightValue}</td></tr>
          </tbody>
          <tfoot>
            <tr>
              <td><strong>Difference</strong></td>
              <td className="r">
                <strong style={{ color: gap === 0 ? undefined : "var(--bad)" }}>
                  {money(String(gap))}
                </strong>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="card-body">
        <span className="hint">{note}</span>
        {" "}
        <Link className="subline" href={href}>{hrefLabel}</Link>
      </div>
    </div>
  );
}
