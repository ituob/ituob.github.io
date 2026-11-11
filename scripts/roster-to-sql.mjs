#!/usr/bin/env node
// Seed path for the TSB member roster (docs/membership-roles.adoc).
// Reads data-members/members.csv (PR-reviewed) and prints idempotent SQL:
//   node scripts/roster-to-sql.mjs data-members/members.csv > seed.sql
//   wrangler d1 execute <db> --file seed.sql      (staging first)
// Columns: id,name,register_key,iso3166_alpha2,itu_identifier,member_since,status
// Rows are upserted by id; members missing from the CSV are never deleted.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); if (row.some((x) => x !== "")) rows.push(row); }
  const [head, ...data] = rows;
  return data.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

const q = (v) => (v === undefined || v === "" ? "NULL" : `'${String(v).replaceAll("'", "''")}'`);

export function toSql(records, at = new Date().toISOString()) {
  const out = [];
  for (const r of records) {
    for (const k of ["id", "name", "register_key"]) if (!r[k]) throw new Error(`row missing ${k}: ${JSON.stringify(r)}`);
    const status = r.status || "active";
    if (!["active", "suspended", "withdrawn"].includes(status)) throw new Error(`bad status for ${r.id}`);
    out.push(
      `INSERT INTO members (id, name, register_key, iso3166_alpha2, itu_identifier, status, member_since, created_at, updated_at) ` +
        `VALUES (${q(r.id)}, ${q(r.name)}, ${q(r.register_key)}, ${q(r.iso3166_alpha2)}, ${q(r.itu_identifier)}, ${q(status)}, ${q(r.member_since)}, ${q(at)}, ${q(at)}) ` +
        `ON CONFLICT(id) DO UPDATE SET name=excluded.name, register_key=excluded.register_key, iso3166_alpha2=excluded.iso3166_alpha2, ` +
        `itu_identifier=excluded.itu_identifier, status=excluded.status, member_since=excluded.member_since, updated_at=excluded.updated_at;`,
    );
  }
  return out.join("\n") + "\n";
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const file = process.argv[2];
  if (!file) { console.error("usage: roster-to-sql.mjs members.csv"); process.exit(2); }
  process.stdout.write(toSql(parseCsv(readFileSync(file, "utf8"))));
}
