// A stand-in for the CrAInium people door (its contract: one JSON object on stdout, exit 3 when unreachable).
// Usage: <db.json> <log.txt> <verb> [arg]. Keeps its people in the db file; a `<db>.down` file makes it unreachable;
// a put is `stale` when the stored row is as new or newer than the record.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const [db, log, verb, arg] = process.argv.slice(2)
appendFileSync(log, `${verb}\n`)
const out = (obj, code = 0) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
  process.exit(code)
}
if (existsSync(`${db}.down`)) out({ ok: false, code: 'unreachable', error: 'down' }, 3)
const rows = existsSync(db) ? JSON.parse(readFileSync(db, 'utf8')) : {}
if (verb === 'status')
  out({ ok: true, owner: 'example', reachable: true, people: Object.keys(rows).length })
if (verb === 'list')
  out({
    ok: true,
    people: Object.values(rows).map((r) => ({
      id: r.id,
      family: r.family,
      slug: r.slug,
      name: r.persona.name ?? r.slug,
      updatedAt: r.updatedAt,
    })),
  })
if (verb === 'get') out({ ok: true, record: rows[arg] ?? null })
if (verb === 'put') {
  let text = ''
  process.stdin.on('data', (d) => (text += d))
  process.stdin.on('end', () => {
    const rec = JSON.parse(text)
    const have = rows[rec.id]
    if (have && Date.parse(have.updatedAt) >= Date.parse(rec.updatedAt))
      out({ ok: false, code: 'stale', error: 'as new or newer' })
    rows[rec.id] = rec
    writeFileSync(db, JSON.stringify(rows))
    out({ ok: true, id: rec.id, updatedAt: rec.updatedAt })
  })
} else if (verb === 'delete')
  out({ ok: false, code: 'unsupported', error: 'CrAInium keeps every row' }, 1)
else out({ ok: false, code: 'invalid', error: 'unknown verb' }, 1)
