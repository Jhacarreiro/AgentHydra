#!/usr/bin/env node
// Hydra Core catalog builder (node 22, no dependencies).
//   node catalog/build.mjs           rebuild catalog/generated-<source>.json (never touches hand-*.json)
//   node catalog/build.mjs --check   validate generated + hand files, print counts, exit 1 when invalid or too small
// Every parser tolerates missing fields: an entry that cannot be made valid is skipped and counted, never fatal.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// Home paths come from os.homedir() (HOME / USERPROFILE). Owner-specific sources (sibling repos, Boardroom
// ids, the pinned-prompt lane) are read from <core>/catalog/sources.json when it exists; see docs/PEOPLE.md.
const HOME = homedir().replace(/\\/g, '/')
const CORE = (process.env.AGENTHYDRA_CORE_DIR || `${HOME}/.agenthydra/core`).replace(/\\/g, '/')
const CATALOG = `${CORE}/catalog`
const PINNED_OUT = `${CORE}/knowledge/pinned`
const cfgText = (() => { try { return readFileSync(`${CATALOG}/sources.json`, 'utf8').replace(/^\uFEFF/, '') } catch { return '' } })()
const CFG = (() => { try { const j = JSON.parse(cfgText); return j && typeof j === 'object' ? j : {} } catch { return {} } })()
const cfgPath = (k) => (typeof CFG[k] === 'string' && CFG[k] ? CFG[k].replace(/\\/g, '/').replace(/^~(?=\/|$)/, HOME) : '')
const cfgList = (k) => (Array.isArray(CFG[k]) ? CFG[k].map((v) => String(v).replace(/\\/g, '/').replace(/^~(?=\/|$)/, HOME)) : [])
const PROJECTS = cfgPath('projectsDir')
const CONN = cfgPath('connectionsDir')
const SKILL_DIRS = [`${HOME}/.claude/skills`, ...cfgList('extraSkillDirs')]
const AGENT_DIRS = [`${HOME}/.claude/agents`, ...cfgList('extraAgentDirs')]
const DREDD = cfgPath('dreddDir')
const SNAPSHOT = cfgPath('snapshotDir')
const LANE = cfgPath('laneDir')
const OWNER = typeof CFG.ownerName === 'string' ? CFG.ownerName : ''

const KINDS = ['person', 'instrument', 'worker', 'knowledge', 'skill']
const TIERS = ['intern', 'employee', 'manager', 'owner']
const FAMILIES = ['intern', 'manager', 'board', 'expert', 'dredd-seat', 'sue', 'ape', 'art', 'you-sue', 'creator']
const MODES = ['become', 'consult', 'hire']
const COSTS = ['free', 'low', 'medium', 'high']
const LOAD_TYPES = ['file', 'skill', 'tool', 'none']

// ---------- small helpers ----------
const fwd = (p) => String(p).replace(/\\/g, '/')
const safeRead = (p) => { try { return readFileSync(p, 'utf8').replace(/^\uFEFF/, '') } catch { return null } }
const safeJson = (p) => { const t = safeRead(p); if (t == null) return null; try { return JSON.parse(t) } catch { return null } }
const safeDir = (p) => { try { return readdirSync(p, { withFileTypes: true }) } catch { return [] } }
const isFile = (p) => existsSync(p)
const slugify = (s, max = 70) => String(s || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '')
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v))

/** One plain line, markdown stripped, at most `max` characters (default 159: the spec says under 160). */
function oneLine(s, max = 159) {
  const t = str(s).replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[`*]/g, '').replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max - 1)
  const dot = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '))
  if (dot > 60) return cut.slice(0, dot + 1)
  const sp = cut.lastIndexOf(' ')
  return (sp > 40 ? cut.slice(0, sp) : cut).replace(/[,;:\s-]+$/, '') + '…'
}
const capHow = (s) => { const t = str(s).replace(/\s+/g, ' ').trim(); return t.length > 600 ? t.slice(0, 597) + '...' : t }
const tagsAll = (...lists) => [...new Set(lists.flat().map((t) => str(t).toLowerCase().trim()).filter((t) => t && t.length <= 40))]
const tagsOf = (...lists) => tagsAll(...lists).slice(0, 8)

/** Minimal YAML front matter: key: value, folded/literal blocks, and `- item` lists. Comment lines are ignored. */
function frontMatter(text) {
  const out = { fm: {}, lists: {}, body: str(text) }
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(out.body)
  if (!m) return out
  out.body = out.body.slice(m[0].length)
  let cur = null
  for (const line of m[1].split(/\r?\n/)) {
    if (/^\s*#/.test(line) || !line.trim()) continue
    const k = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line)
    if (k) {
      cur = k[1]
      let v = k[2].trim()
      if (/^[>|][+-]?$/.test(v)) v = ''
      out.fm[cur] = v
      continue
    }
    const li = /^\s+-\s+(.*)$/.exec(line)
    if (li && cur) { (out.lists[cur] ||= []).push(li[1].trim().replace(/^["']|["']$/g, '')); continue }
    if (cur && /^\s+/.test(line)) out.fm[cur] = (out.fm[cur] + ' ' + line.trim()).trim()
  }
  for (const k of Object.keys(out.fm)) out.fm[k] = out.fm[k].replace(/^(["'])([\s\S]*)\1$/, '$2')
  return out
}
const firstHeading = (body) => { const m = /^#\s+(.+)$/m.exec(str(body)); return m ? m[1].trim() : '' }
const firstPara = (body) => {
  for (const p of str(body).split(/\r?\n\s*\r?\n/)) {
    const t = p.trim()
    if (t && !/^(#|<!--|---|```|\||>)/.test(t)) return t
  }
  return ''
}
function costOf(text) {
  const t = str(text).toLowerCase()
  if (!t) return 'low'
  if (/\bfree\b|\$0|no cost/.test(t)) return 'free'
  if (/hour|real (people|visitor)|dollar|\$\d/.test(t)) return 'high'
  if (/minute|visitor|opus|model/.test(t)) return 'medium'
  return 'low'
}

// ---------- validation (shared by build and --check) ----------
// Each rule is [isBad(entry), message]. Walking the table in order keeps the first-error-wins
// behaviour and the error order the checks always had.
const firstFailure = (rules, e) => {
  for (const [bad, msg] of rules) if (bad(e)) return msg
  return null
}
const ENTRY_RULES = [
  [(e) => !KINDS.includes(e.kind), 'bad kind'],
  [(e) => !e.id.startsWith(e.kind + ':') || e.id.length <= e.kind.length + 1 || /\s/.test(e.id), 'bad id'],
  [(e) => e.when.length >= 160, 'when too long'],
  [(e) => /[\r\n]/.test(e.when), 'when not one line'],
  [(e) => e.how.length > 600, 'how too long'],
  [(e) => e.name.length > 120, 'name too long'],
  [(e) => e.title != null && (typeof e.title !== 'string' || e.title.length > 200), 'bad title'],
  [(e) => !Array.isArray(e.tags) || e.tags.some((t) => typeof t !== 'string'), 'bad tags'],
  [(e) => !COSTS.includes(e.cost), 'bad cost'],
]
const PERSON_RULES = [
  [(e) => !TIERS.includes(e.tier), 'person without valid tier'],
  [(e) => !FAMILIES.includes(e.family), 'person without valid family'],
  [(e) => e.tier === 'owner' && Array.isArray(e.modes) && e.modes.includes('become'), 'owner tier is consult only'],
  [(e) => e.reportsTo != null && !(typeof e.reportsTo === 'string' && e.reportsTo.startsWith('person:')), 'reportsTo must be a person id'],
  [(e) => e.division != null && (typeof e.division !== 'string' || !e.division), 'bad division'],
  [(e) => !Array.isArray(e.modes) || !e.modes.length || e.modes.some((m) => !MODES.includes(m)), 'person without valid modes'],
]
const NON_PERSON_RULES = [
  [(e) => e.tier != null || e.modes != null || e.family != null || e.reportsTo != null || e.division != null, 'person fields on a non-person'],
]
const FOLDER_RULES = [
  [(e) => e.folders != null && (!Array.isArray(e.folders) || e.folders.some((f) => typeof f !== 'string')), 'bad folders'],
]
const LOAD_FIELD_RULES = [['file', 'path'], ['skill', 'name'], ['tool', 'call']].map(([type, field]) => [
  (e) => e.load.type === type && (typeof e.load[field] !== 'string' || !e.load[field]),
  `load ${type} without ${field}`,
])
const LOAD_RULES = [
  [(e) => !e.load || typeof e.load !== 'object' || !LOAD_TYPES.includes(e.load.type), 'bad load'],
  ...LOAD_FIELD_RULES,
  [(e) => JSON.stringify(e).length > 3000, 'entry too long (persona text inside the JSON?)'],
]

export function validate(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return 'not an object'
  for (const k of ['id', 'kind', 'name', 'when', 'how', 'source']) if (typeof e[k] !== 'string' || !e[k].trim()) return `missing ${k}`
  return firstFailure(ENTRY_RULES, e) || firstFailure(e.kind === 'person' ? PERSON_RULES : NON_PERSON_RULES, e)
    || firstFailure(FOLDER_RULES, e) || firstFailure(LOAD_RULES, e)
}

// ---------- source runner ----------
const allSkips = {}
function runSource(name, fn) {
  const skips = { count: 0, reasons: {}, examples: [] }
  const seen = new Set()
  const out = []
  const skip = (why, id) => {
    skips.count++
    skips.reasons[why] = (skips.reasons[why] || 0) + 1
    if (id && skips.examples.length < 5) skips.examples.push(`${id}: ${why}`)
  }
  const add = (e) => {
    const err = validate(e)
    if (err) return skip(err, e && e.id)
    if (seen.has(e.id)) return skip('duplicate id', e.id)
    seen.add(e.id)
    out.push(e)
  }
  try { fn(add, skip) } catch (err) { skip('source failed: ' + str(err && err.message).split('\n')[0].slice(0, 120)) }
  mkdirSync(CATALOG, { recursive: true })
  writeFileSync(`${CATALOG}/generated-${name}.json`, JSON.stringify(out, null, 2) + '\n')
  allSkips[name] = skips
  console.log(`${name}: ${out.length} entries, ${skips.count} skipped`)
}

// ---------- 2. skills ----------
function skills(add, skip) {
  for (const root of SKILL_DIRS) {
    for (const d of safeDir(root)) {
      if (!d.isDirectory()) continue
      const file = `${root}/${d.name}/SKILL.md`
      const t = safeRead(file)
      if (t == null) { skip('no SKILL.md', d.name); continue }
      const { fm } = frontMatter(t)
      const name = slugify(fm.name || d.name)
      const desc = fm.description || ''
      if (!desc) { skip('no description', name); continue }
      // A skill written as a person ("<Name> on <field> ... what would <Name> say") is listed by the people add-on, not here.
      if (/^[A-Z][A-Za-z.'’\- ]{1,40}? on /.test(desc) && /what would .{1,40} say/i.test(desc)) continue
      add({
        id: `skill:${name}`, kind: 'skill', name, title: undefined, when: oneLine(desc), tags: tagsOf(fm.field, name.split('-')),
        cost: 'free', how: `Invoke the Skill tool with skill "${name}"; it loads its instructions into this chat.`,
        load: { type: 'skill', name }, source: `${file}:1 (front matter name, description)`
      })
    }
  }
}

// ---------- 3. Dredd ----------
function dredd(add, skip) {
  if (!DREDD) return
  addDreddDocket(add)
  dreddInstruments(add, skip)
  dreddMemberCapabilities(add, skip)
}

function addDreddDocket(add) {
  const doc = existsSync(`${DREDD}/README.md`) ? { type: 'file', path: `${DREDD}/README.md` } : { type: 'none' }
  add({
    id: 'instrument:dredd', kind: 'instrument', name: 'Dredd', title: 'Docket: which instruments to convene for an ask',
    when: "A new ask bigger than a one-line fact or edit: Dredd's docket names the instruments to convene, in what order, and the model for each.",
    tags: ['dredd', 'docket', 'instruments', 'judge'], cost: 'low',
    how: `AgentHydra \`dredd { action: "docket", ask: "<the ask>" }\` (or \`node ${DREDD}/dredd.mjs "<the ask>"\`). Follow the docket; skipping an instrument it named takes a one-line reason.`,
    load: doc, source: `${DREDD}/bench.json ($doc); Connections lane brief 'Dredd first'`
  })
}

function instrumentLoad(i) {
  const docRef = str(i.doc).split(/[,(]/)[0].trim()
  if (docRef) {
    for (const base of [CONN, DREDD, DREDD.replace(/\/[^/]*$/, '')].filter(Boolean)) {
      if (isFile(`${base}/${docRef}`) && !/\/$/.test(docRef)) return { type: 'file', path: `${base}/${docRef}` }
    }
  }
  return { type: 'none' }
}

function instrumentHow(i) {
  return capHow(`Dredd convenes it in a docket: AgentHydra dredd tool { action: "docket", ask }.${i.run ? ' Runner: ' + str(i.run) + '.' : ''}${i.doc ? ' Doc: ' + str(i.doc) + '.' : ''}`)
}

function dreddInstruments(add, skip) {
  const bench = safeJson(`${DREDD}/bench.json`)
  if (!bench || !Array.isArray(bench.instruments)) { skip('bench.json missing or no instruments array'); return }
  for (const i of bench.instruments) {
    const id = slugify(i && i.id)
    if (!id) { skip('instrument without id'); continue }
    const w = str(i.when)
    const when = w.length >= 40 ? w : `${str(i.judges)} ${w}`
    add({
      id: `instrument:${id}`, kind: 'instrument', name: str(i.name) || id, when: oneLine(when || i.name),
      tags: tagsOf(i.plane, i.owner, i.domains || [], id.split('-')), cost: costOf(i.cost),
      how: instrumentHow(i),
      load: instrumentLoad(i), source: `${DREDD}/bench.json instruments[id=${id}] (when, judges, run, doc, cost)`
    })
  }
}

function dreddMemberCapabilities(add, skip) {
  const mb = safeJson(`${DREDD}/member-bench.json`)
  if (mb && Array.isArray(mb.capabilities)) {
    for (const c of mb.capabilities) {
      const id = slugify(c && c.id)
      if (!id) { skip('member capability without id'); continue }
      add({
        id: `knowledge:member-${id}`, kind: 'knowledge', name: str(c.name) || id, when: oneLine(c.what || c.jev || c.name),
        tags: tagsOf('member', c.owner, id.split('-')), cost: 'free',
        how: capHow(`Read the row in sue-dredd/dredd/member-bench.json (id ${id}); its setting names the exact constant or table.${c.owner ? ' Owner plane: ' + str(c.owner) + '.' : ''}`),
        load: { type: 'file', path: `${DREDD}/member-bench.json` }, source: `${DREDD}/member-bench.json capabilities[id=${id}] (what, setting, owner)`
      })
    }
  }
}

// ---------- 4. agents ----------
function agents(add, skip) {
  for (const root of AGENT_DIRS) {
    for (const f of safeDir(root)) {
      if (!f.isFile() || !f.name.endsWith('.md')) continue
      const file = `${root}/${f.name}`
      const t = safeRead(file)
      if (t == null) { skip('agent unreadable', f.name); continue }
      const { fm } = frontMatter(t)
      const name = slugify(fm.name || f.name.replace(/\.md$/, ''))
      const model = str(fm.model).toLowerCase()
      add({
        id: `worker:${name}`, kind: 'worker', name, when: oneLine(fm.description || `Sub-agent type ${name}`),
        tags: tagsOf('agent', model, name.split('-')), cost: /opus/.test(model) ? 'high' : /haiku/.test(model) ? 'low' : 'medium',
        how: `Agent tool with subagent_type "${name}"${model ? ` (model ${model}${fm.effort ? ', effort ' + fm.effort : ''})` : ''}.`,
        load: { type: 'file', path: file }, source: `${file}:1 (front matter name, description, model)`
      })
    }
  }
}

// ---------- 5. repo rules ----------
function repos(add, skip) {
  if (!PROJECTS) return
  for (const d of safeDir(PROJECTS)) {
    if (!d.isDirectory()) continue
    const dir = `${PROJECTS}/${d.name}`
    const file = ['AGENTS.md', 'CLAUDE.md'].map((n) => `${dir}/${n}`).find(isFile)
    if (!file) continue
    add({
      id: `knowledge:repo-${slugify(d.name)}`, kind: 'knowledge', name: `${d.name} repo rules`,
      when: oneLine(`read before you edit, commit, test or deploy in ${d.name}`), tags: tagsOf('repo', 'rules', d.name), cost: 'free',
      folders: [dir], how: `Read ${file} before you edit, commit, test or deploy here (core_use mode "load" returns it).`,
      load: { type: 'file', path: file }, source: file
    })
  }
  const rulesDir = CONN ? `${CONN}/.claude/rules` : ''
  for (const f of safeDir(rulesDir)) {
    if (!f.isFile() || !f.name.endsWith('.md')) continue
    const file = `${rulesDir}/${f.name}`
    const t = safeRead(file)
    if (t == null) { skip('rule unreadable', f.name); continue }
    const { fm, lists, body } = frontMatter(t)
    const slug = slugify(f.name.replace(/\.md$/, ''))
    const desc = fm.description || firstHeading(body) || firstPara(body) || slug.replace(/-/g, ' ')
    const paths = lists.paths && lists.paths.length ? lists.paths : fm.paths ? [fm.paths] : []
    const scope = paths.length ? ` [paths: ${paths.slice(0, 3).join(', ')}]` : ''
    add({
      id: `knowledge:rule-${slug}`, kind: 'knowledge', name: oneLine(firstHeading(body) || slug, 120),
      when: oneLine(oneLine(desc, 159 - scope.length) + scope), tags: tagsOf('rule', 'connections', slug.split('-')), cost: 'free',
      folders: [CONN], how: `Read ${file}; it auto-loads when you touch ${paths.length ? paths.join(', ') : 'matching files'}.`,
      load: { type: 'file', path: file }, source: `${file}:1 (description or first heading, paths)`
    })
  }
}

// ---------- 6. CrAInium docs (Connections' docs: filed under Connections, so a pack in another folder never attaches them) ----------
function* walkMd(dir, depth = 0) {
  if (depth > 8) return
  for (const d of safeDir(dir)) {
    if (d.isDirectory()) {
      if (['.claude', '.agents', '.git', 'node_modules'].includes(d.name)) continue
      yield* walkMd(`${dir}/${d.name}`, depth + 1)
    } else if (d.isFile() && /\.md$/i.test(d.name)) yield `${dir}/${d.name}`
  }
}
function crainium(add, skip) {
  if (!CONN) return
  if (!existsSync(SNAPSHOT)) {
    add({
      id: 'knowledge:crainium-docs', kind: 'knowledge', name: 'CrAInium docs', when: 'The CrAInium documentation (architecture, how-to, governance, ai-memory): search it when the repo rules do not answer.',
      tags: ['crainium', 'docs'], cost: 'low', folders: [CONN],
      how: "connections_execute { local:true, tool_name:'docs', params:{ action:'search', query:'<topic>' } } (the Connections docs tool).",
      load: { type: 'tool', call: "connections_execute { local:true, tool_name:'docs', params:{ action:'search', query:'<topic>' } }" },
      source: 'snapshot missing; Connections docs tool'
    })
    return
  }
  for (const file of walkMd(SNAPSHOT)) {
    const t = safeRead(file)
    if (t == null) { skip('doc unreadable'); continue }
    const rel = file.slice(SNAPSHOT.length + 1)
    const { fm, body } = frontMatter(t)
    const title = fm.title || firstHeading(body)
    const desc = fm.description || firstPara(body)
    if (!title && !desc) { skip('no title or description', rel); continue }
    let slug = slugify(rel.replace(/\.md$/i, ''), 80)
    if (!slug) { skip('empty slug', rel); continue }
    add({
      id: `knowledge:crainium-${slug}`, kind: 'knowledge', name: oneLine(title || rel, 120),
      when: oneLine(desc || `CrAInium doc: ${title}`), tags: tagsOf('crainium', rel.split('/').slice(0, -1)), cost: 'free', folders: [CONN],
      how: `Read ${file} (core_use mode "load" returns it).`, load: { type: 'file', path: file },
      source: `${file}:1 (front matter ${fm.title ? 'title' : 'first heading'}, ${fm.description ? 'description' : 'first paragraph'})`
    })
  }
}

// ---------- 7. owner's pinned instructions (cached lane briefs) ----------
const SECRET_LINE = [
  /\b(sk-[A-Za-z0-9_-]{16,}|ghp_\w{20,}|github_pat_\w{20,}|gho_\w{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[\w-]{10,}|AIza[\w-]{30,}|eyJ[\w-]{20,}\.[\w-]{10,})/,
  /(api[_ -]?key|secret|token|password|passwd|credential|auth)s?["']?\s*[:=]\s*["']?[A-Za-z0-9_\-/+=.]{12,}/i,
  /BEGIN [A-Z ]*PRIVATE KEY/,
  /\bbearer\s+[A-Za-z0-9_\-.=]{20,}/i
]
const looksSecret = (line) => SECRET_LINE.some((r) => r.test(line))

function splitH1(text) {
  const sections = []
  let cur = null
  let fence = false
  for (const line of str(text).split(/\r?\n/)) {
    if (/^\s*```/.test(line)) fence = !fence
    const h = !fence && /^# (.+)$/.exec(line)
    if (h) { cur = { title: h[1].trim(), lines: [] }; sections.push(cur); continue }
    if (cur) cur.lines.push(line)
  }
  return sections
}
function pinned(add, skip) {
  if (!LANE) return
  mkdirSync(PINNED_OUT, { recursive: true })
  const files = safeDir(LANE).filter((d) => d.isFile() && /^brief-.*\.json$/.test(d.name)).map((d) => d.name).sort()
  if (!files.length) skip('no lane briefs found')
  const done = new Set()
  for (const f of files) {
    const j = safeJson(`${LANE}/${f}`)
    if (!j || typeof j.text !== 'string') { skip('brief unreadable or no text', f); continue }
    for (const sec of splitH1(j.text)) {
      const slug = slugify(sec.title, 60)
      if (!slug) { skip('empty pinned slug', f); continue }
      if (done.has(slug)) continue
      done.add(slug)
      const kept = []
      for (const line of sec.lines) {
        if (looksSecret(line)) { skip('credential-looking line dropped', slug); continue }
        kept.push(line)
      }
      const body = kept.join('\n').trim()
      if (!body) { skip('empty pinned section', slug); continue }
      const path = `${PINNED_OUT}/${slug}.md`
      writeFileSync(path, `# ${sec.title}\n\nSource: ${LANE}/${f} (Connections pinned prompt, split by build.mjs)\n\n${body}\n`)
      add({
        id: `knowledge:pinned-${slug}`, kind: 'knowledge', name: oneLine(sec.title, 120),
        when: oneLine((OWNER ? OWNER + "'s pinned ruling: " : 'Pinned ruling: ') + (firstPara(body).replace(/^[-*]\s*/, '') || sec.title)), tags: tagsOf('pinned', OWNER, 'ruling', slug.split('-').slice(0, 4)), cost: 'free',
        how: `Read ${path}; core_use mode "load" returns it.`, load: { type: 'file', path }, source: `${LANE}/${f} text (H1 section "${oneLine(sec.title, 60)}")`
      })
    }
  }
}

// ---------- build ----------
function build() {
  // People are not a source here: the people add-on writes generated-people.json when it loads. These files came from the
  // sources that moved out; left behind they would keep listing people on a PC without the add-on.
  for (const name of ['managers', 'boardroom', 'owners']) rmSync(`${CATALOG}/generated-${name}.json`, { force: true })
  runSource('skills', skills)
  runSource('dredd', dredd)
  runSource('agents', agents)
  runSource('repos', repos)
  runSource('crainium', crainium)
  runSource('pinned', pinned)
  writeFileSync(`${CATALOG}/skips.json`, JSON.stringify(allSkips, null, 2) + '\n')
}

// ---------- check ----------
function loadFile(path) {
  const t = safeRead(path)
  if (t == null) return { error: 'unreadable' }
  try {
    const a = JSON.parse(t)
    return Array.isArray(a) ? { entries: a } : { error: 'not a JSON array' }
  } catch (e) { return { error: 'invalid JSON: ' + str(e.message).slice(0, 80) } }
}
function check() {
  let bad = 0
  const fail = (m) => { bad++; console.log('INVALID: ' + m) }
  const files = safeDir(CATALOG).filter((d) => d.isFile() && /^(generated|hand)-.*\.json$/.test(d.name)).map((d) => d.name).sort()
  if (!files.length) fail('no catalog files; run the builder first (node hydra-core/catalog/build.mjs)')
  const byLayer = { generated: new Map(), hand: new Map() }
  for (const f of files) {
    const layer = f.startsWith('hand-') ? 'hand' : 'generated'
    const r = loadFile(`${CATALOG}/${f}`)
    if (r.error) { fail(`${f}: ${r.error}`); continue }
    r.entries.forEach((e, i) => {
      const err = validate(e)
      if (err) return fail(`${f}[${i}] ${e && e.id}: ${err}`)
      if (byLayer[layer].has(e.id)) return fail(`${f}[${i}]: duplicate id ${e.id} (also in ${byLayer[layer].get(e.id).file})`)
      byLayer[layer].set(e.id, { e, file: f })
    })
  }
  const merged = new Map([...byLayer.generated].map(([k, v]) => [k, v.e]))
  let overridden = 0
  for (const [k, v] of byLayer.hand) { if (merged.has(k)) overridden++; merged.set(k, v.e) }
  const all = [...merged.values()]
  const by = (fn) => all.reduce((m, e) => { const k = fn(e); if (k) m[k] = (m[k] || 0) + 1; return m }, {})
  const kinds = by((e) => e.kind)
  const tiers = by((e) => e.tier)
  console.log(`catalog: ${all.length} entries (${byLayer.generated.size} generated, ${byLayer.hand.size} hand, ${overridden} generated replaced by hand)`)
  console.log('by kind: ' + JSON.stringify(kinds))
  console.log('by tier: ' + JSON.stringify(tiers))
  const sk = safeJson(`${CATALOG}/skips.json`)
  console.log('skips per source: ' + (sk ? Object.entries(sk).map(([k, v]) => `${k}=${v.count}`).join(' ') : 'unknown (skips.json missing)'))
  if (sk) for (const [k, v] of Object.entries(sk)) if (v.count) console.log(`  ${k}: ${JSON.stringify(v.reasons)} e.g. ${v.examples.join(' | ')}`)
  // Floors come from sources.json "minimums"; a fresh install has none, so an empty catalog is valid.
  const floor = CFG.minimums && typeof CFG.minimums === 'object' ? CFG.minimums : {}
  const need = [
    ['managers', tiers.manager || 0, floor.managers || 0],
    ['employees', tiers.employee || 0, floor.employees || 0],
    ['instruments', kinds.instrument || 0, floor.instruments || 0],
    ['skills', kinds.skill || 0, floor.skills || 0],
    ['knowledge entries', kinds.knowledge || 0, floor.knowledge || 0]
  ]
  for (const [label, have, min] of need) if (have < min) fail(`only ${have} ${label}, need at least ${min}`)
  console.log(bad ? `CHECK FAILED: ${bad} problem(s)` : 'CHECK OK')
  process.exit(bad ? 1 : 0)
}

if (process.argv.includes('--check')) check()
else build()
