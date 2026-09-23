import { readFileSync } from "node:fs";
import postgres from "postgres";
const [url, file] = process.argv.slice(2);
const local = url.includes("127.0.0.1") || url.includes("localhost");
const sql = postgres(url, { ssl: local ? false : "require", onnotice: () => {}, max: 1 });
const out = await sql.unsafe(readFileSync(file, "utf8"));
const rows = Array.isArray(out[0]) ? out.at(-1) : out;
for (const r of rows) console.log("   ", Object.values(r).join("  "));
await sql.end({ timeout: 5 });
