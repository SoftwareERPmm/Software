import Link from "next/link";
import { money, qty, shortDate } from "@/lib/db";
import {
  getCompany, getItems, getStockMovements, getStockOpeningBalance, getVariantStock,
} from "@/lib/queries";
import { VariantTags, asVariant } from "@/components/variant-tags";
import { ItemThumb } from "@/components/item-thumb";
import { variantPhotos } from "@/lib/variants";
import { AccountPicker } from "@/components/account-picker";
import { DataTable, type DataRow } from "@/components/data-table";
import { HelpHint } from "@/components/help-hint";

const label = (t: string) => t.replace(/_/g, " ").toLowerCase();

/** Only a real date gets through; anything else is treated as not set. */
const asDate = (v: string | undefined) =>
  v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;

export default async function StockMovements({
  searchParams,
}: {
  searchParams: Promise<{ item?: string; from?: string; to?: string }>;
}) {
  const { item, from: rawFrom, to: rawTo } = await searchParams;
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const from = asDate(rawFrom);
  const to = asDate(rawTo);

  const allItems = (await getItems(company.id)) as unknown as Array<{
    id: string; code: string; name: string; is_stocked: boolean;
    variant_count: number; variant: unknown; photo_version: string | null;
  }>;
  /**
   * A product with variants is left out.
   *
   * It cannot appear on a document line — fn_document_line_not_parent
   * refuses it — so it can never have a movement, and offering it here only
   * leads to "nothing has moved on this item yet" about a shirt with a
   * hundred and ten pieces on the shelf. The variants are what moved.
   */
  const items = allItems.filter((i) => i.is_stocked && i.variant_count === 0);

  /**
   * Everything, unless one item is asked for.
   *
   * The default used to be whichever item sorted first, which answered a
   * question nobody had asked and left the rest of the ledger behind a
   * dropdown. Opening on the whole log is the honest default; narrowing to
   * one item is the deliberate act.
   */
  const selected = item && item !== "all" ? items.find((i) => i.id === item) ?? null : null;
  const oneItem = selected !== null;

  const rows = (await getStockMovements(
    company.id, selected?.id ?? null, from, to,
  )) as unknown as Array<{
    id: string; movement_date: string; qty: string; unit_cost: string;
    total_cost: string; batch_no: string | null; doc_no: string | null;
    doc_type: string; document_id: string | null; location_code: string;
    item_code: string; item_name: string;
  }>;

  /**
   * A running balance means something only for one item, and only if it
   * starts from where that item actually stood.
   *
   * Filtering to September and beginning the column at nought would say the
   * item was empty on the first, which the filter never claimed. So what it
   * held before the window opens is carried in.
   */
  const opening = oneItem && from
    ? await getStockOpeningBalance(company.id, selected!.id, from)
    : 0;

  let balance = opening;
  const withBalance = rows.map((r) => {
    balance += Number(r.qty);
    return { ...r, balance };
  });
  // Newest first when it is a log; a stock card stays chronological or its
  // running balance reads as wrong.
  const ordered = oneItem ? withBalance : [...withBalance].reverse();

  // The garment beside the heading, resolved by colour so a card for the
  // small red one shows the red shirt even when the photograph was
  // uploaded against the medium.
  const variantStock = (await getVariantStock(company.id)) as unknown as
    Parameters<typeof variantPhotos>[0];
  const photos = variantPhotos(variantStock);
  const mine = selected ? variantStock.find((v) => v.id === selected.id) : undefined;
  const photoSrc = mine
    ? photos.srcFor(mine)
    : selected?.photo_version
      ? `/items/${selected.id}/photo?v=${selected.photo_version}`
      : null;

  const moved = ordered.reduce((t, r) => t + Math.abs(Number(r.qty)), 0);

  const tableRows: DataRow[] = ordered.map((r) => ({
    key: r.id,
    searchText: [r.doc_no, r.doc_type, r.location_code, r.batch_no,
                 r.item_code, r.item_name].filter(Boolean).join(" "),
    node: (
      <tr>
        <td className="code">{shortDate(r.movement_date)}</td>
        {!oneItem && (
          <td className="wrap">
            <span className="m">{r.item_code}</span>
            <div className="subline">{r.item_name}</div>
          </td>
        )}
        <td className="code">
          {r.document_id ? (
            <Link href={`/documents/${r.document_id}`} style={{ color: "var(--brand)" }}>
              {r.doc_no ?? label(r.doc_type)}
            </Link>
          ) : (
            "—"
          )}
        </td>
        <td className="code">{r.location_code}</td>
        <td className="code">
          {/* A revaluation moves value and no goods: the bill disagreed with
              the receipt and the difference went back onto stock that was
              already here. Said in the batch column because both quantity
              columns are correctly empty, and a row with nothing in either
              otherwise reads as a movement that failed to record. */}
          {Number(r.qty) === 0 ? "revaluation" : r.batch_no ?? "—"}
        </td>
        <td className="r">{Number(r.qty) > 0 ? qty(r.qty) : ""}</td>
        <td className="r">{Number(r.qty) < 0 ? qty(String(-Number(r.qty))) : ""}</td>
        <td className="r">
          {Number(r.qty) === 0 ? money(r.total_cost) : money(r.unit_cost)}
        </td>
        {oneItem && <td className="r">{qty(String(r.balance))}</td>}
      </tr>
    ),
  }));

  const columns = [
    { key: "date", label: "Date" },
    ...(!oneItem ? [{ key: "item", label: "Item" }] : []),
    { key: "document", label: "Document" },
    { key: "location", label: "Location" },
    { key: "batch", label: "Batch" },
    { key: "in", label: "In", align: "r" as const },
    { key: "out", label: "Out", align: "r" as const },
    { key: "cost", label: "Unit cost", align: "r" as const },
    ...(oneItem ? [{ key: "balance", label: "Balance", align: "r" as const }] : []),
  ];

  const dated = Boolean(from || to);

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Inventory</span>
        <h1>Stock movements</h1>
        <HelpHint>
          Every receipt, delivery, transfer, and adjustment, in order — and a
          running balance once one item is chosen, which makes it a stock
          card. Nothing here is stored separately; it&rsquo;s the same
          append-only ledger the Stock page sums.
        </HelpHint>
      </div>

      {items.length === 0 ? (
        <div className="empty">No stocked items yet.</div>
      ) : (
        <>
          <div className="row movefilters">
            <AccountPicker
              accounts={[{ id: "all", code: "—", name: "All items" }, ...items]}
              selectedId={selected?.id ?? "all"}
              basePath="/inventory/movements"
              paramName="item"
              label="Item"
              keep={{ from: from ?? undefined, to: to ?? undefined }}
            />

            {/* A plain GET form: two dates and a button, no JavaScript, and
                what comes back is a URL somebody can keep. */}
            <form method="get" action="/inventory/movements" className="daterange">
              <input type="hidden" name="item" value={selected?.id ?? "all"} />
              <div className="field">
                <label htmlFor="from">From</label>
                <input id="from" name="from" type="date" defaultValue={from ?? ""} />
              </div>
              <div className="field">
                <label htmlFor="to">To</label>
                <input id="to" name="to" type="date" defaultValue={to ?? ""} />
              </div>
              <button type="submit" className="btn ghost">Apply</button>
              {dated && (
                <Link className="btn ghost"
                      href={`/inventory/movements${selected ? `?item=${selected.id}` : ""}`}>
                  Clear
                </Link>
              )}
            </form>
          </div>

          <section>
            <div className="card">
              <div className="card-head">
                {oneItem ? (
                  <h2 className="movehead">
                    <ItemThumb src={photoSrc} name={selected!.name} />
                    <span>
                      {selected!.code} &middot; {selected!.name}
                      <VariantTags variant={asVariant(selected!.variant)}
                                   className="vartags-inline" labelled />
                    </span>
                  </h2>
                ) : (
                  <h2>All items</h2>
                )}
                <span className="page-sub">
                  {ordered.length} movement{ordered.length === 1 ? "" : "s"}
                  {dated && ` · ${from ? shortDate(from) : "the start"} to ${
                    to ? shortDate(to) : "today"}`}
                  {oneItem
                    ? ` · on hand ${qty(String(balance))}`
                    : ` · ${qty(String(moved))} units moved`}
                </span>
              </div>

              {/* Said out loud, because a running balance that begins part
                  way through its own history is the one figure on this page
                  somebody could reasonably misread. */}
              {oneItem && from && (
                <div className="card-body" style={{ paddingBottom: 0 }}>
                  <span className="page-sub">
                    Balance carried in from before {shortDate(from)}:{" "}
                    <strong>{qty(String(opening))}</strong>
                  </span>
                </div>
              )}

              {ordered.length === 0 ? (
                <div className="empty">
                  {dated
                    ? "Nothing moved in that period."
                    : oneItem
                      ? "Nothing has moved on this item yet."
                      : "Nothing has moved yet."}
                </div>
              ) : (
                // Search only, deliberately no sort — Balance is a running
                // total tied to chronological order, and reordering the rows
                // would make it read as wrong even though each value is
                // still historically accurate.
                <DataTable
                  rows={tableRows}
                  emptyLabel="No matches"
                  searchPlaceholder="Search movements…"
                  columns={columns}
                />
              )}
            </div>
          </section>
        </>
      )}
    </>
  );
}
