// server/src/mcp-pricecheck.ts - price_check and its family: what each page of a web app costs the person looking at it,
// the page to trim next, a live render, the baseline freeze, and the report written into the project's dashboard.
// Each tool runs the pricecheck CLI (pricecheck/bin/pricecheck.mjs) with this runtime, inside the call budget.
import { execFile } from 'node:child_process'
import { join, resolve } from 'node:path'
import { progress, readHistory, recordScan } from '../../pricecheck/lib/history.mjs'
import { describe as describePage, type Scan, type ScanPage } from '../../pricecheck/lib/model.mjs'
import { nextTrim } from '../../pricecheck/lib/next.mjs'
import { renderReport } from '../../pricecheck/lib/report-html.mjs'
import { APP_ROOT } from './config'
import { api, type HydraTool, JSON_HEADERS, MCP_CALL_BUDGET_MS, S, str } from './mcp-client'
import { CWD, folderOf } from './mcp-dashboards'

const BIN = join(APP_ROOT, 'pricecheck', 'bin', 'pricecheck.mjs')
const CLI_BUDGET_MS = MCP_CALL_BUDGET_MS - 8_000
const DEFAULT_LIMIT = 15
const REPORT_PATH = 'price/index.html'

export interface CliRun {
  code: number | null
  stdout: string
  stderr: string
  overBudget: boolean
}

export interface PriceCheckDeps {
  runCli: (args: string[], root: string, timeoutMs: number) => Promise<CliRun>
  gitRoot: (folder: string) => Promise<string>
  postDashboard: (body: unknown) => Promise<unknown>
}

const runCli = (args: string[], root: string, timeoutMs: number) =>
  new Promise<CliRun>((done) => {
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

const gitRoot = (folder: string) =>
  new Promise<string>((done, fail) => {
    execFile(
      'git',
      ['-C', folder, 'rev-parse', '--show-toplevel'],
      { timeout: 10_000, windowsHide: true },
      (err, stdout) => {
        if (err)
          fail(
            new Error(`${folder} is not inside a git repository, so there is no project to price`),
          )
        else done(resolve(String(stdout).trim()))
      },
    )
  })

const postDashboard = (body: unknown) =>
  api('/api/dashboards/workspace', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  })

const LIVE_DEPS: PriceCheckDeps = { runCli, gitRoot, postDashboard }

class Budget {
  private readonly end = Date.now() + CLI_BUDGET_MS
  left(): number {
    return Math.max(1_000, this.end - Date.now())
  }
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const tail = (run: CliRun) =>
  (run.stderr.trim() || run.stdout.trim()).slice(-600) || `exit ${run.code}`

const overBudget = (run: CliRun) => ({
  ok: false,
  overBudget: true,
  note: `pricecheck ran past the ${CLI_BUDGET_MS / 1000} s call budget and was stopped; output holds what it had printed. Call again, or price one file with mode page.`,
  output: run.stdout.slice(-4000),
})

function parseScan(run: CliRun, root: string): Scan {
  const data = parseJson(run.stdout) as Scan | null
  if (!data || !Array.isArray(data.pages))
    throw new Error(`pricecheck scan printed no scan: ${tail(run)}`)
  return { ...data, root }
}

const withDescribe = (p: ScanPage) => ({ ...p, describe: describePage(p) })

const isPage = (x: unknown): x is ScanPage =>
  typeof x === 'object' &&
  x !== null &&
  typeof (x as ScanPage).page === 'string' &&
  typeof (x as ScanPage).points === 'number'

type Scanned = { scan: Scan; recorded: boolean } | { stopped: CliRun }

async function scanRecorded(deps: PriceCheckDeps, root: string, budget: Budget): Promise<Scanned> {
  const run = await deps.runCli(['scan', '--json'], root, budget.left())
  if (run.overBudget) return { stopped: run }
  const scan = parseScan(run, root)
  return { scan, recorded: recordScan(scan).written }
}

const total = (scan: Scan) => Math.round(scan.pages.reduce((sum, p) => sum + p.points, 0) * 10) / 10

export function priceCheckTools(deps: PriceCheckDeps = LIVE_DEPS): HydraTool[] {
  const rootOf = async (a: Record<string, unknown>) => deps.gitRoot((await folderOf(a)).cwd)

  return [
    {
      name: 'price_check',
      callerChat: 'deskChat',
      listed: true,
      description:
        "Prices every page of a web app: what each page costs the person looking at it (words, controls, fields, sections, other-product pushes...) and which file each point comes from. mode scan ranks every page most expensive first, with a one-line describe per page, and appends a snapshot to the price history kept outside the repo. mode page prices one page file by file. mode diff prices what the working tree's changes cost, against a ref (default HEAD) or for the files named. mode check fails when a page rose without a written reason or has no frozen price. cwd is any folder inside the project; omitted, it is the calling Desk chat's folder.",
      inputSchema: S(
        {
          cwd: CWD,
          mode: {
            type: 'string',
            enum: ['scan', 'page', 'diff', 'check'],
            description: 'scan, page, diff or check (see the description).',
          },
          page: { type: 'string', description: 'The page file, for mode page.' },
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
      run: async (a: Record<string, unknown>) => {
        const root = await rootOf(a)
        const budget = new Budget()
        const mode = str(a.mode)
        if (mode === 'scan') {
          const scanned = await scanRecorded(deps, root, budget)
          if ('stopped' in scanned) return overBudget(scanned.stopped)
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
          const run = await deps.runCli(['page', file, '--json'], root, budget.left())
          if (run.overBudget) return overBudget(run)
          const row = parseJson(run.stdout)
          if (isPage(row)) return withDescribe(row)
          const scanRun = await deps.runCli(['scan', '--json'], root, budget.left())
          if (scanRun.overBudget) return overBudget(scanRun)
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
          const run = await deps.runCli(args, root, budget.left())
          if (run.overBudget) return overBudget(run)
          const data = parseJson(run.stdout)
          if (!data) throw new Error(`pricecheck diff printed no JSON: ${tail(run)}`)
          return data
        }
        if (mode === 'check') {
          const run = await deps.runCli(['check'], root, budget.left())
          if (run.overBudget) return overBudget(run)
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
        "Names the page to trim next in a web app: the one with the most exposure (or points) that was not cut in the last 7 days, with its price, each file's share, and a brief a worker can run as it is. It also returns the progress since the first snapshot. It scans and records a snapshot, as price_check mode scan does. cwd is any folder inside the project; omitted, it is the calling Desk chat's folder.",
      inputSchema: S({ cwd: CWD }),
      run: async (a: Record<string, unknown>) => {
        const root = await rootOf(a)
        const scanned = await scanRecorded(deps, root, new Budget())
        if ('stopped' in scanned) return overBudget(scanned.stopped)
        const cli = `"${process.execPath}" "${BIN}"`
        const next = nextTrim(scanned.scan, readHistory(root), { cli })
        return {
          root,
          next,
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
        "Prices a page as a real browser renders it, at desktop and phone width: what is actually on screen, and the component that drew each thing. Read-only. url must start with http:// or https://. cwd is any folder inside the project; omitted, it is the calling Desk chat's folder.",
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
      run: async (a: Record<string, unknown>) => {
        const url = str(a.url).trim()
        if (!/^https?:\/\//i.test(url)) throw new Error('url must start with http:// or https://')
        const root = await rootOf(a)
        const args = ['live', url, '--json']
        const cdp = str(a.cdp).trim()
        if (cdp) args.push('--cdp', cdp)
        const run = await deps.runCli(args, root, new Budget().left())
        if (run.overBudget) return overBudget(run)
        const data = parseJson(run.stdout)
        if (!data) throw new Error(`pricecheck live printed no JSON: ${tail(run)}`)
        return data
      },
    },
    {
      name: 'price_check_freeze',
      callerChat: 'deskChat',
      description:
        "MUTATES: freezes every page's current price as the project's baseline, .pricecheck/baseline.json. From then on a page's price may only fall; a rise needs a reason. cwd is any folder inside the project; omitted, it is the calling Desk chat's folder.",
      inputSchema: S({
        cwd: CWD,
        reason: { type: 'string', description: 'Why a page may rise; written into the baseline.' },
      }),
      run: async (a: Record<string, unknown>) => {
        const root = await rootOf(a)
        const reason = str(a.reason).trim()
        const args = ['freeze']
        if (reason) args.push('--reason', reason)
        const run = await deps.runCli(args, root, new Budget().left())
        if (run.overBudget) return overBudget(run)
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
        "MUTATES: writes the price report into the project's AgentHydra dashboard as price/index.html, and returns its url. The report holds the totals, the progress since the first snapshot, the ranking, and each page's file shares. Only price/index.html is written. cwd is any folder inside the project; omitted, it is the calling Desk chat's folder.",
      inputSchema: S({ cwd: CWD }),
      run: async (a: Record<string, unknown>) => {
        const root = await rootOf(a)
        const scanned = await scanRecorded(deps, root, new Budget())
        if ('stopped' in scanned) return overBudget(scanned.stopped)
        const html = renderReport({ scan: scanned.scan, progress: progress(root) })
        const answer = (await deps.postDashboard({
          cwd: root,
          by: 'price check',
          files: [{ path: REPORT_PATH, content: html, encoding: 'utf8' }],
        })) as { url?: unknown } | null
        return {
          root,
          file: REPORT_PATH,
          url: typeof answer?.url === 'string' ? answer.url : null,
          pages: scanned.scan.pages.length,
          total: total(scanned.scan),
        }
      },
    },
  ]
}

export const PRICECHECK_TOOLS: HydraTool[] = priceCheckTools()
