// Everything a company's documents say, in a form something could re-post.
//
//   DATABASE_URL="<source>" npx tsx scripts/export-documents.mjs > backup.json
//
// Read-only. Writes nothing, anywhere.
//
// Not a database dump: a dump carries the journal entries, and the whole
// point of replaying is to let the engine write those again under whatever
// rules it has now. This carries only what a person typed — the documents,
// their lines, and which document each was raised from — identified by code
// and number rather than by id, so it can be read back into a database whose
// ids are all different.
//
// Ordered by posting date and number, because FIFO depends on the order
// goods arrived and left. Replaying out of order would cost the sales
// differently and quietly produce a different set of books.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!process.env.DATABASE_URL && existsSync(join(root, ".env"))) {
  for (const line of readFileSync(join(root, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/);
    if (m) process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, "");
  }
}
const url = process.env.DATABASE_URL;
const local = url.includes("localhost") || url.includes("127.0.0.1");
const pooled = url.includes("-pooler.") || url.includes("pgbouncer=true");
const sql = postgres(url, { ssl: local ? false : "require", prepare: !pooled, onnotice: () => {} });

const [co] = await sql`select id, name, code from company order by created_at limit 1`;

const docs = await sql`
  select d.id, d.doc_no, d.doc_type, d.status, d.version,
         to_char(d.doc_date, 'YYYY-MM-DD') as doc_date,
         to_char(d.posting_date, 'YYYY-MM-DD') as posting_date,
         to_char(d.due_date, 'YYYY-MM-DD') as due_date,
         d.reference, d.memo, d.payment_type, d.currency, d.exchange_rate,
         d.delivery_fee, d.price_includes_tax, d.to_deliver,
         d.net_total, d.tax_total, d.gross_total,
         d.voucher_direction, d.salesman_id,
         p.code as partner_code, l.code as location_code,
         src.doc_no as source_doc_no,
         rev.doc_no as reverses_doc_no
    from document d
    left join business_partner p on p.id = d.partner_id
    left join location l on l.id = d.location_id
    left join document src on src.id = d.source_document_id
    left join document rev on rev.id = d.reverses_document_id
   where d.company_id = ${co.id}
   order by d.posting_date, d.doc_no, d.version`;

const lines = await sql`
  select dl.document_id, dl.line_no,
         i.code as item_code, l.code as location_code,
         dl.entered_qty, u.code as uom_code, dl.conversion_factor, dl.base_qty,
         dl.unit_price, dl.discount_pct, dl.discount_amount,
         dl.net_amount, dl.gross_amount, dl.tax_amount,
         tc.code as tax_code, f.code as foc_code,
         dl.is_consignment,
         sl.document_id as source_document_id, sl.line_no as source_line_no
    from document_line dl
    join document d on d.id = dl.document_id
    left join item i on i.id = dl.item_id
    left join location l on l.id = dl.location_id
    left join uom u on u.id = dl.entered_uom_id
    left join tax_code tc on tc.id = dl.tax_code_id
    left join foc_reason f on f.id = dl.foc_reason_id
    left join document_line sl on sl.id = dl.source_line_id
   where d.company_id = ${co.id}
   order by dl.document_id, dl.line_no`;

const byDoc = new Map();
for (const l of lines) {
  const list = byDoc.get(l.document_id) ?? [];
  const { document_id, source_document_id, ...rest } = l;
  list.push({
    ...rest,
    source_doc_no: source_document_id
      ? docs.find((d) => d.id === source_document_id)?.doc_no ?? null
      : null,
  });
  byDoc.set(document_id, list);
}

process.stdout.write(JSON.stringify({
  exportedAt: new Date().toISOString(),
  company: { name: co.name, code: co.code },
  counts: { documents: docs.length, lines: lines.length },
  documents: docs.map(({ id, ...d }) => ({ ...d, lines: byDoc.get(id) ?? [] })),
}, null, 2));

await sql.end();
