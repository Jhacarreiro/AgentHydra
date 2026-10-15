// The price_check tools: what each page of a web app costs the person looking at it, the page to trim next, a live render,
// the baseline freeze, the report, and the advice log. Each tool runs the pricecheck CLI (this checkout's bin) once,
// inside the call budget. A host may supply folderOf, postDashboard and callBudgetMs; deps is the test seam.
import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { adviceFile, homeDir, newId, readRows, recordAdvice } from '../lib/advice/log.mjs'
import { sharedView } from '../lib/advice/lessons.mjs'
import { reconcile, summarize } from '../lib/advice/reconcile.mjs'
import { progress, readHistory, recordScan } from '../lib/history.mjs'
import { describe as describePage } from '../lib/model.mjs'
import { nextTrim } from '../lib/next.mjs'
import { renderReport } from '../lib/report-html.mjs'

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'pricecheck.mjs')
const DEFAULT_CALL_BUDGET_MS = 50_000
const CALL_ANSWER_MARGIN_MS = 8_000
const DEFAULT_LIMIT = 15
const REPORT_PATH = 'price/index.html'
const BAD_VERDICTS = ['wrong', 'undone']
const BAD_OUTCOMES = ['undone', 'misled']

const str = (v) => String(v ?? '')
const S = (properties = {}, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})
const CWD = {
  type: 'string',
  description:
    'Any folder inside the project (the checkout is found from it). Omitted, the working folder is used.',
}

const runCli = (args, root, timeoutMs) =>
  new Promise((done) => {
    execFile(
      process.execPath,
      [BIN, ...args, '--root', root],
      { cwd: root, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        done({
          code: err ? (typeof err.code === 'number' ? err.code : null) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
          overBudget: err?.killed === true,
        })
      },
    )
  })

const gitRoot = (folder) =>
  new Promise((done, fail) => {
    execFile(
      'git',
      ['-C', folder, 'rev-parse', '--show-toplevel'],
      { timeout: 10_000, windowsHide: true },
      (err, stdout) => {
        if (err)
          fail(new Error(`${folder} is not inside a git repository, so there is no project to price`))
        else done(resolve(String(stdout).trim()))
      },
    )
  })

const defaultFolderOf = async (a) => ({ cwd: str(a.cwd).trim() || process.cwd() })

class Budget {
  constructor(ms) {
    this.end = Date.now() + ms
  }
  left() {
    return Math.max(1_000, this.end - Date.now())
  }
}

const parseJson = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const tail = (run) => (run.stderr.trim() || run.stdout.trim()).slice(-600) || `exit ${run.code}`

const overBudget = (run, budgetMs) => ({
  ok: false,
  overBudget: true,
  note: `pricecheck ran past the ${budgetMs / 1000} s call budget and was stopped; output holds what it had printed. Call again, or price one file with mode page.`,
  output: run.stdout.slice(-4000),
})

function parseScan(run, root) {
  const data = parseJson(run.stdout)
  if (!data || !Array.isArray(data.pages)) throw new Error(`pricecheck scan printed no scan: ${tail(run)}`)
  return { ...data, root }
}

const withDescribe = (p) => ({ ...p, describe: describePage(p) })

const isPage = (x) =>
  typeof x === 'object' && x !== null && typeof x.page === 'string' && typeof x.points === 'number'

const total = (scan) => Math.round(scan.pages.reduce((sum, p) => sum + p.points, 0) * 10) / 10

function recordNext(pick, root) {
  try {
    return recordAdvice({
      id: pick.adviceId,
      kind: 'next',
      root,
      page: pick.page,
      points: pick.points,
      files: pick.topFiles.map((f) => ({ file: f.file, points: f.points })),
      claim: pick.claim,
    })
  } catch {
    return null
  }
}

function adviceOf(root) {
  const summary = summarize(root)
  const want = resolve(root)
  const rows = readRows(adviceFile())
  const mine = rows.filter((r) => r.type === 'advice' && r.id && r.root && resolve(r.root) === want)
  let open = 0
  let latestBad = null
  for (const a of mine) {
    const feedback = rows.filter((r) => r.type === 'feedback' && r.adviceId === a.id)
    const outcomes = rows.filter((r) => r.type === 'outcome' && r.adviceId === a.id)
    if (feedback.length === 0 && outcomes.length === 0) open++
    const bad =
      feedback.some((f) => BAD_VERDICTS.includes(f.verdict ?? '')) ||
      outcomes.some((o) => BAD_OUTCOMES.includes(o.kind ?? ''))
    if (!bad || (latestBad && (a.at ?? '') <= latestBad.at)) continue
    const whys = feedback.filter((f) => f.why)
    latestBad = {
      id: a.id,
      at: a.at ?? '',
      kind: a.kind,
      page: a.page ?? null,
      points: a.points ?? null,
      claim: a.claim ?? null,
      verdicts: feedback.map((f) => f.verdict),
      outcomes: outcomes.map((o) => o.kind),
      why: whys.length ? whys[whys.length - 1].why : null,
    }
  }
  return { summary, open, latestBad }
}

function adviceSummary(s, open) {
  return {
    issued: s.issued,
    followed: s.followed,
    undone: s.undone,
    misled: s.misled,
    wrong: s.feedback.wrong,
    right: s.feedback.right,
    stale: s.stale,
    open,
    badRate: s.badRate,
  }
}

function adviceAcrossProjects() {
  const roots = [
    ...new Set(readRows(adviceFile()).filter((r) => r.type === 'advice' && r.root).map((r) => resolve(r.root))),
  ]
  const views = roots.map((root) => adviceOf(root))
  const sum = (pick) => views.reduce((n, v) => n + pick(v), 0)
  const issued = sum((v) => v.summary.issued)
  const bad = sum((v) => (v.summary.badRate == null ? 0 : Math.round(v.summary.badRate * v.summary.issued)))
  const latest = views
    .map((v) => v.latestBad)
    .filter((b) => b !== null)
    .sort((a, b) => b.at.localeCompare(a.at))[0]
  return {
    projects: roots.length,
    summary: {
      issued,
      followed: sum((v) => v.summary.followed),
      undone: sum((v) => v.summary.undone),
      misled: sum((v) => v.summary.misled),
      wrong: sum((v) => v.summary.feedback.wrong),
      right: sum((v) => v.summary.feedback.right),
      stale: sum((v) => v.summary.stale),
      open: sum((v) => v.open),
      badRate: issued === 0 ? null : bad / issued,
    },
    latestBad: latest ?? null,
  }
}

function writeLocalReport(root, html) {
  const dir = join(homeDir(), 'reports', basename(root))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'index.html')
  writeFileSync(file, html)
  return file
}

export function priceCheckTools(host = {}, deps = {}) {
  const callBudgetMs = host.callBudgetMs ?? DEFAULT_CALL_BUDGET_MS
  const cliBudgetMs = callBudgetMs - CALL_ANSWER_MARGIN_MS
  const seam = {
    runCli,
    gitRoot,
    postDashboard: host.postDashboard,
    reconcile,
    ...deps,
  }
  const folderOf = host.folderOf ?? defaultFolderOf
  const rootOf = async (a) => seam.gitRoot((await folderOf(a)).cwd)
  const budget = () => new Budget(cliBudgetMs)
  const scanRecorded = async (root, b) => {
    const run = await seam.runCli(['scan', '--json'], root, b.left())
    if (run.overBudget) return { stopped: run }
    const scan = parseScan(run, root)
    const recorded = recordScan(scan).written
    try {
      seam.reconcile(root)
    } catch {
      // advice bookkeeping never fails a scan
    }
    return { scan, recorded }
  }
  const stopped = (run) => overBudget(run, cliBudgetMs)

  return [
    {
      name: 'price_check',
      callerChat: 'deskChat',
      listed: true,
      description:
        "Prices every page of a web app: what each page costs the person looking at it (words, controls, fields, sections, other-product pushes...) and which file each point comes from. mode scan ranks every page most expensive first, with a one-line describe per page, and appends a snapshot to the price history kept outside the repo. mode page prices one page file by file. mode diff prices what the working tree's changes cost, against a ref (default HEAD) or for the files named. mode check fails when a page rose without a written reason or has no frozen price. cwd is any folder inside the project; omitted, it is the working folder.",
      inputSchema: S(
        {
          cwd: CWD,
          mode: {
            type: 'string',
            enum: ['scan', 'page', 'diff', 'check'],
            description: 'scan, page, diff or check (see the description).',
          },
          page: { type: 'string', description: 'The page file, for mode page.' },
          tree: {
            type: 'boolean',
            description:
              'With mode page: also treeLines, the render tree as lines, each rendered component with its points, dearest first.',
          },
          against: {
            type: 'string',
            description: 'A git ref to diff against (default HEAD), for mode diff.',
          },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Changed files to restrict the diff to, for mode diff.',
          },
          limit: {
            type: 'integer',
            description: `How many pages mode scan returns, most expensive first (default ${DEFAULT_LIMIT}). The history always holds every page.`,
          },
        },
        ['mode'],
      ),
      run: async (a) => {
        const root = await rootOf(a)
        const b = budget()
        const mode = str(a.mode)
        if (mode === 'scan') {
          const scanned = await scanRecorded(root, b)
          if ('stopped' in scanned) return stopped(scanned.stopped)
          const limit = Math.max(1, Math.floor(Number(a.limit ?? DEFAULT_LIMIT)) || DEFAULT_LIMIT)
          return {
            root,
            mode: scanned.scan.mode,
            total: total(scanned.scan),
            pagesTotal: scanned.scan.pages.length,
            pages: scanned.scan.pages.slice(0, limit).map(withDescribe),
            history: { recorded: scanned.recorded },
          }
        }
        if (mode === 'page') {
          const file = str(a.page).trim()
          if (!file) throw new Error('mode page needs page: the page file, as scan lists it')
          const args = ['page', file, '--json']
          if (a.tree === true) args.push('--tree')
          const run = await seam.runCli(args, root, b.left())
          if (run.overBudget) return stopped(run)
          const row = parseJson(run.stdout)
          if (isPage(row)) {
            const { tree: _nested, ...rest } = row
            return withDescribe(rest)
          }
          const scanRun = await seam.runCli(['scan', '--json'], root, b.left())
          if (scanRun.overBudget) return stopped(scanRun)
          const found = parseScan(scanRun, root).pages.find((p) => p.page === file)
          if (!found) return { ok: false, error: `no page named ${file} in ${root}` }
          return withDescribe(found)
        }
        if (mode === 'diff') {
          const args = ['diff', '--json']
          const against = str(a.against).trim()
          if (against) args.push('--against', against)
          const files = Array.isArray(a.files) ? a.files.map(str).filter(Boolean) : []
          if (files.length) args.push('--files', files.join(','))
          const run = await seam.runCli(args, root, b.left())
          if (run.overBudget) return stopped(run)
          const data = parseJson(run.stdout)
          if (!data) throw new Error(`pricecheck diff printed no JSON: ${tail(run)}`)
          return data
        }
        if (mode === 'check') {
          const run = await seam.runCli(['check'], root, b.left())
          if (run.overBudget) return stopped(run)
          const failures =
            run.code === 0
              ? []
              : `${run.stdout}\n${run.stderr}`
                  .split('\n')
                  .map((s) => s.trim())
                  .filter(Boolean)
          return { root, ok: run.code === 0, failures }
        }
        throw new Error('mode must be scan, page, diff or check')
      },
    },
    {
      name: 'price_check_next',
      callerChat: 'deskChat',
      description:
        "Names the page or shared file to trim next in a web app: the one with the most exposure (or points), a shared file summed over every page it is on and a page skipped while it was cut in the last 7 days, with its price, each file's share, and a brief a worker can run as it is. It also returns the progress since the first snapshot. It scans and records a snapshot, as price_check mode scan does. cwd is any folder inside the project; omitted, it is the working folder.",
      inputSchema: S({ cwd: CWD }),
      run: async (a) => {
        const root = await rootOf(a)
        const scanned = await scanRecorded(root, budget())
        if ('stopped' in scanned) return stopped(scanned.stopped)
        const cli = `"${process.execPath}" "${BIN}"`
        const next = nextTrim(scanned.scan, readHistory(root), { cli, adviceId: newId() })
        return {
          root,
          next,
          adviceId: next ? recordNext(next, root) : null,
          ...(next
            ? {}
            : {
                note: 'nothing left to trim: every page is free, or was cut in the last 7 days and has not moved since',
              }),
          progress: progress(root),
          history: { recorded: scanned.recorded },
        }
      },
    },
    {
      name: 'price_check_live',
      callerChat: 'deskChat',
      description:
        "Prices a page as a real browser renders it, at desktop and phone width: what is actually on screen, and the component that drew each thing. Read-only. url must start with http:// or https://. cwd is any folder inside the project; omitted, it is the working folder.",
      inputSchema: S(
        {
          url: { type: 'string', description: 'The page to render, http or https.' },
          cwd: CWD,
          cdp: {
            type: 'string',
            description: 'A Chrome DevTools endpoint to attach to, instead of starting a browser.',
          },
        },
        ['url'],
      ),
      run: async (a) => {
        const url = str(a.url).trim()
        if (!/^https?:\/\//i.test(url)) throw new Error('url must start with http:// or https://')
        const root = await rootOf(a)
        const args = ['live', url, '--json']
        const cdp = str(a.cdp).trim()
        if (cdp) args.push('--cdp', cdp)
        const run = await seam.runCli(args, root, budget().left())
        if (run.overBudget) return stopped(run)
        const data = parseJson(run.stdout)
        if (!data) throw new Error(`pricecheck live printed no JSON: ${tail(run)}`)
        return data
      },
    },
    {
      name: 'price_check_freeze',
      callerChat: 'deskChat',
      description:
        "MUTATES: freezes every page's current price as the project's baseline, .pricecheck/baseline.json. From then on a page's price may only fall; a rise needs a reason. cwd is any folder inside the project; omitted, it is the working folder.",
      inputSchema: S({
        cwd: CWD,
        reason: { type: 'string', description: 'Why a page may rise; written into the baseline.' },
      }),
      run: async (a) => {
        const root = await rootOf(a)
        const reason = str(a.reason).trim()
        const args = ['freeze']
        if (reason) args.push('--reason', reason)
        const run = await seam.runCli(args, root, budget().left())
        if (run.overBudget) return stopped(run)
        return {
          root,
          ok: run.code === 0,
          output: run.code === 0 ? run.stdout.trim() : tail(run),
          baseline: join(root, '.pricecheck', 'baseline.json'),
        }
      },
    },
    {
      name: 'price_check_report',
      callerChat: 'deskChat',
      description:
        "MUTATES: writes the price report as price/index.html, into the project's AgentHydra dashboard when one is reachable (its url is returned), else under PRICECHECK_HOME/reports/<repo> (its path is returned). The report holds the totals, the progress since the first snapshot, the ranking, and each page's file shares. Only that one file is written. cwd is any folder inside the project; omitted, it is the working folder.",
      inputSchema: S({ cwd: CWD }),
      run: async (a) => {
        const root = await rootOf(a)
        const scanned = await scanRecorded(root, budget())
        if ('stopped' in scanned) return stopped(scanned.stopped)
        const html = renderReport({ scan: scanned.scan, progress: progress(root) })
        const common = { root, pages: scanned.scan.pages.length, total: total(scanned.scan) }
        if (!seam.postDashboard) {
          const path = writeLocalReport(root, html)
          return { ...common, file: REPORT_PATH, path, url: null }
        }
        const answer = await seam.postDashboard({
          cwd: root,
          by: 'price check',
          files: [{ path: REPORT_PATH, content: html, encoding: 'utf8' }],
        })
        return {
          ...common,
          file: REPORT_PATH,
          url: typeof answer?.url === 'string' ? answer.url : null,
        }
      },
    },
    {
      name: 'price_check_advice',
      callerChat: 'deskChat',
      description:
        "Reads how the advice from price_check_next went: issued, followed (the page was cut), undone (it rose again), misled (it rose after a version change), wrong or right (feedback from price_check_feedback), stale (no outcome after 30 days) and open, with badRate, the share of issued advice that went bad (lower is better). It also returns the newest bad advice and the why its feedback gave. cwd is any folder inside the project; omitted, it is the working folder. all: true counts every project instead. shared: true returns instead the lessons (advice that went bad) every PC has committed to the shared core, newest first, with a tally per machine.",
      inputSchema: S({
        cwd: CWD,
        all: { type: 'boolean', description: 'Count every project, not only the one cwd is in.' },
        shared: { type: 'boolean', description: 'Return the lessons every PC committed to the shared lessons folder instead.' },
      }),
      run: async (a) => {
        if (a.shared === true) return sharedView()
        if (a.all === true) return { root: null, ...adviceAcrossProjects() }
        const root = await rootOf(a)
        const view = adviceOf(root)
        return { root, summary: adviceSummary(view.summary, view.open), latestBad: view.latestBad }
      },
    },
    {
      name: 'price_check_feedback',
      callerChat: 'deskChat',
      description:
        "MUTATES: records feedback on advice from price_check_next in the advice log. verdict wrong: the advice or pricecheck's number was wrong. undone: the change the advice led to was undone. right: the advice held. Call it when pricecheck's number or advice was wrong, or when you undid a change the advice led to. advice is the adviceId price_check_next returned; claim says what was claimed; why says what went wrong. cwd is any folder inside the project; omitted, it is the working folder.",
      inputSchema: S(
        {
          cwd: CWD,
          verdict: { type: 'string', description: 'wrong, undone or right (see the description).' },
          claim: { type: 'string', description: 'What the advice or the price claimed.' },
          advice: { type: 'string', description: 'The adviceId price_check_next returned, when this is about a brief.' },
          page: { type: 'string', description: 'The page file the feedback is about.' },
          why: { type: 'string', description: 'What went wrong, in a sentence.' },
          by: { type: 'string', description: 'Who gave the feedback.' },
        },
        ['verdict', 'claim'],
      ),
      run: async (a) => {
        const verdict = str(a.verdict).trim()
        const claim = str(a.claim).trim()
        if (!verdict) throw new Error('verdict is required: wrong, undone or right')
        if (!claim) throw new Error('claim is required: say what the advice or the price claimed')
        const root = await rootOf(a)
        const args = ['feedback', '--verdict', verdict, '--claim', claim]
        for (const [flag, key] of [
          ['--advice', 'advice'],
          ['--page', 'page'],
          ['--why', 'why'],
          ['--by', 'by'],
        ]) {
          const value = str(a[key]).trim()
          if (value) args.push(flag, value)
        }
        const run = await seam.runCli(args, root, budget().left())
        if (run.overBudget)
          throw new Error(
            'pricecheck feedback ran past the call budget, so it may or may not have been recorded: check price_check_advice before you retry',
          )
        if (run.code !== 0) throw new Error(tail(run))
        const id = /recorded feedback (\S+)/.exec(run.stdout)?.[1] ?? null
        return { root, id, verdict }
      },
    },
  ]
}
