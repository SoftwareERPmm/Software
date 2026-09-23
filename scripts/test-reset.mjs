// Emptying the transaction tables, without a list that goes stale.
//
// Every suite used to carry its own `truncate table ...` naming the tables it
// knew about. There were at least four different lists, and all of them
// predated consignment agreements, delivery trips, routes, bank statements
// and serials — so leftovers from those blocked item and partner deletion in
// suites that had never heard of them. A hardcoded list is a list that drifts.
//
// So the list is derived instead: start from the roots of a transaction —
// the document, its journal entry, and the stock it moved — and take every
// table that depends on them, however many times removed. A table added next
// year is included the day it gets a foreign key, without anybody
// remembering to come back here.
//
// Master data is never touched. Items, partners, accounts and warehouses are
// referenced *by* documents, not the other way round, so they are not in the
// closure and could not be swept up by it.

const ROOTS = [
  "document", "journal_entry", "stock_movement", "stock_lot",
  "opening_batch", "negative_stock", "bank_statement", "delivery_trip",
  // Not documents, but not master data either: a consignment agreement and
  // a delivery beat are standing arrangements that point at items and
  // partners. A suite that replaces the item catalogue cannot delete a row
  // one of these still references, which is exactly how the audit run died
  // on "violates foreign key constraint consignment_agreement_line_item_id_fkey"
  // and again on route_stop. Suites build their own, so clearing them
  // between runs costs nothing.
  "consignment_agreement", "route",
];

/** Every table that depends on a transaction root, transitively. */
export async function transactionTables(sql) {
  const edges = await sql`
    select tc.table_name as child, ccu.table_name as parent
      from information_schema.table_constraints tc
      join information_schema.constraint_column_usage ccu
        on ccu.constraint_name = tc.constraint_name
     where tc.constraint_type = 'FOREIGN KEY'
       and tc.table_schema = 'public'`;

  const children = new Map();
  for (const { child, parent } of edges) {
    if (child === parent) continue;
    if (!children.has(parent)) children.set(parent, new Set());
    children.get(parent).add(child);
  }

  const out = new Set();
  const walk = (t) => {
    if (out.has(t)) return;
    out.add(t);
    for (const c of children.get(t) ?? []) walk(c);
  };
  for (const r of ROOTS) walk(r);
  return [...out];
}

/**
 * Put the database back to "nothing has been posted yet".
 *
 * Also reopens the fiscal calendar, which no suite used to do and which is
 * the one that genuinely wedged things: truncating documents removes the
 * year-end closing entry while leaving the year CLOSED, and the application
 * then cannot reopen it — there is no close left to reverse. A suite run
 * after a year end would leave the database in a state only raw SQL could
 * recover.
 */
export async function resetTransactions(sql) {
  const tables = await transactionTables(sql);
  await sql.unsafe(
    `truncate table ${tables.map((t) => `"${t}"`).join(", ")} restart identity cascade`);

  await sql`update fiscal_period set status = 'OPEN' where status <> 'OPEN'`;
  await sql`update fiscal_year   set status = 'OPEN' where status <> 'OPEN'`;
  await sql`update number_series set next_value = 1`;

  return tables.length;
}
