// Prints the chart-of-accounts block for db/seed.sql, built from db/chart.mjs.
//
//   node scripts/gen-seed-chart.mjs            -- print it
//   node scripts/gen-seed-chart.mjs --check    -- exit 1 if seed.sql has drifted
//
// The seed cannot import a module, so its chart is generated text. That is
// the one copy of this data that can silently fall out of step with the
// other two, which is what --check is for — run it after touching the chart.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CHART, SYSTEM } from "../db/chart.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const w = (s, n) => s + " ".repeat(Math.max(1, n - s.length));

const tops = [], nested = [], posts = [];
let section = null;
for (const [code, name, type, postable, flags = {}] of CHART) {
  if (!postable) {
    (flags.under ? nested : tops).push([code, name, type, flags.under ?? null]);
    section = code;
  } else {
    posts.push([section, code, name, type, !!flags.control, !!flags.cash, !!flags.bank]);
  }
}

let out = `-- -------------------------------------------------------------- accounts --
-- The MTK chart, generated from db/chart.mjs by scripts/gen-seed-chart.mjs.
-- The same 65 accounts lib/setup.ts scaffolds and scripts/load-coa.mjs
-- loads: the demo and a real company are the same shape, so a report that
-- reads right here reads right there. Regenerate after changing the chart.

-- Sections. Not postable — they are the headings the chart is read under.
insert into account (company_id, code, name, account_type, is_postable) values
`;
out += tops.map(([c, n, t]) =>
  `    (co, ${w(q(c) + ",", 9)} ${w(q(n) + ",", 38)} ${w(q(t) + ",", 12)} false)`).join(",\n") + ";\n";

out += `
-- Two sections sit under Expense rather than beside it.
insert into account (company_id, parent_id, code, name, account_type, is_postable)
select co, p.id, x.code, x.name, x.atype, false
from (values
`;
out += nested.map(([c, n, t, u]) =>
  `    (${q(u)}, ${q(c)}, ${w(q(n) + ",", 38)} ${q(t)}::account_type)`).join(",\n");
out += `
) as x(parent, code, name, atype)
join account p on p.company_id = co and p.code = x.parent;

-- Postable accounts, each under the section it follows in the chart.
insert into account (company_id, parent_id, code, name, account_type,
                     is_control, is_cash_account, is_bank_account)
select co, p.id, x.code, x.name, x.atype, x.ctrl, x.cash, x.bank
from (values
`;
out += posts.map(([s, c, n, t, ctrl, cash, bank]) =>
  `    (${q(s)}, ${q(c)}, ${w(q(n) + ",", 38)} ${w(q(t) + "::account_type,", 24)} ${w(ctrl + ",", 7)} ${w(cash + ",", 7)} ${bank})`).join(",\n");
out += `
) as x(parent, code, name, atype, ctrl, cash, bank)
join account p on p.company_id = co and p.code = x.parent;

insert into system_account (company_id, role, account_id)
select co, r.role, a.id
from (values
`;
out += Object.entries(SYSTEM).map(([r, c]) => `    (${w(q(r) + ",", 30)} ${q(c)})`).join(",\n");
out += `
) as r(role, code)
join account a on a.company_id = co and a.code = r.code;
`;

if (!process.argv.includes("--check")) {
  process.stdout.write(out);
  process.exit(0);
}

const seed = readFileSync(join(root, "db/seed.sql"), "utf8");
const start = seed.indexOf("-- -------------------------------------------------------------- accounts --");
const end = seed.indexOf("-- ------------------------------------------------------------- locations --");
if (start < 0 || end < 0) {
  console.error("  Could not find the accounts block in db/seed.sql.");
  process.exit(1);
}
const inSeed = seed.slice(start, end).trimEnd();
if (inSeed === out.trimEnd()) {
  console.log(`  db/seed.sql matches db/chart.mjs — ${CHART.length} accounts.`);
  process.exit(0);
}
console.error("\n  db/seed.sql has drifted from db/chart.mjs.\n" +
              "  Regenerate: node scripts/gen-seed-chart.mjs\n");
process.exit(1);
