// scripts/audit-schema.mjs
//
// Compares what migrations/ promises against what a database actually has.
//
// Why this exists: on 2026-09-02 a single `wrangler d1 migrations apply` run
// recorded nine migrations as applied, and at least three of them did not
// take effect. d1_migrations said 0026_ticket_notes.sql was applied; the three
// columns it adds were not there. Nothing surfaced that. The board inbox had
// been returning 500 to every board member since, because its query selects
// two of those columns, and the page reports any error as "you don't hold a
// seat" — so it looked like a permissions quirk for weeks.
//
// The integration suite cannot catch this: it builds a database by running
// every migration from scratch, where they all succeed. Only a real database
// can disagree with its own migration history.
//
// Usage:
//   node scripts/audit-schema.mjs            # production (--remote)
//   node scripts/audit-schema.mjs --local
//
// Exits non-zero when something promised is missing, so it can gate a deploy.

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

const LOCAL = process.argv.includes('--local')
const WHERE = LOCAL ? '--local' : '--remote'
const DIR = 'migrations'

/** Objects a migration creates, minus anything a later one drops. */
function promised() {
  const tables = new Map()
  const indexes = new Map()
  const columns = new Map()

  for (const file of fs.readdirSync(DIR).sort()) {
    if (!file.endsWith('.sql')) continue
    const sql = fs.readFileSync(path.join(DIR, file), 'utf8')

    for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?/gi)) {
      // Rebuild migrations stage through _backup/_new tables and drop them.
      if (!/_backup$|_new$/.test(m[1])) tables.set(m[1], file)
    }
    for (const m of sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?/gi)) {
      indexes.set(m[1], file)
    }
    for (const m of sql.matchAll(/ALTER\s+TABLE\s+["`]?(\w+)["`]?\s+ADD\s+COLUMN\s+["`]?(\w+)["`]?/gi)) {
      if (!columns.has(m[1])) columns.set(m[1], new Map())
      columns.get(m[1]).set(m[2], file)
    }

    // A later migration dropping something is not drift.
    for (const m of sql.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["`]?(\w+)["`]?/gi)) {
      if (!/_backup$/.test(m[1])) {
        tables.delete(m[1])
        columns.delete(m[1])
        for (const [i, f] of indexes) if (i.includes(m[1])) indexes.delete(i, f)
      }
    }
    for (const m of sql.matchAll(/DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?["`]?(\w+)["`]?/gi)) {
      indexes.delete(m[1])
    }
  }
  return { tables, indexes, columns }
}

function query(sql) {
  const out = execSync(
    `npx wrangler d1 execute lca-db ${WHERE} --command "${sql}" --json`,
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
  )
  return JSON.parse(out.slice(out.indexOf('[')))[0].results
}

const want = promised()
const master = query("SELECT type, name FROM sqlite_master WHERE type IN ('table','index');")
const haveTables = new Set(master.filter((r) => r.type === 'table').map((r) => r.name))
const haveIndexes = new Set(master.filter((r) => r.type === 'index').map((r) => r.name))

const problems = []

for (const [table, file] of want.tables) {
  if (!haveTables.has(table)) problems.push(`TABLE  ${table}  (promised by ${file})`)
}
for (const [index, file] of want.indexes) {
  if (!haveIndexes.has(index)) problems.push(`INDEX  ${index}  (promised by ${file})`)
}
for (const [table, cols] of want.columns) {
  if (!haveTables.has(table)) continue
  const actual = new Set(query(`SELECT name FROM pragma_table_info('${table}');`).map((r) => r.name))
  for (const [col, file] of cols) {
    if (!actual.has(col)) problems.push(`COLUMN ${table}.${col}  (promised by ${file})`)
  }
}

const scope = LOCAL ? 'local' : 'production'
if (problems.length === 0) {
  console.log(`Schema matches migrations (${scope}).`)
  process.exit(0)
}

console.log(`Schema drift on ${scope} — ${problems.length} object(s) missing:\n`)
for (const p of problems) console.log('  ' + p)
console.log('\nA migration can be recorded in d1_migrations and still not have run.')
console.log('Repair the database to match, rather than adding a migration: a')
console.log('migration that adds an existing column fails on every other database.')
process.exit(1)
