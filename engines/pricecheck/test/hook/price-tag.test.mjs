import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'hook', 'price-tag.mjs')

// Every test spawns the hook as a real node process (and git), which can pass 5 s on a busy box.
setDefaultTimeout(20_000)

let scratch
let repo
let signIn
let seq = 0

beforeAll(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), 'pricecheck-hook-'))
  repo = path.join(scratch, 'app')
  signIn = path.join(repo, 'src', 'views', 'SignIn.vue')
  mkdirSync(path.join(repo, 'src', 'views'), { recursive: true })
  mkdirSync(path.join(repo, 'src', 'locales'), { recursive: true })
  mkdirSync(path.join(repo, 'src', 'util'), { recursive: true })
  spawnSync('git', ['init', '-q'], { cwd: repo })
  writeFileSync(path.join(repo, 'src', 'views', 'SignIn.vue'), '<template><p>Hi</p></template>\n')
  writeFileSync(path.join(repo, 'src', 'locales', 'en.json'), '{}\n')
  writeFileSync(path.join(repo, 'src', 'util', 'format.ts'), 'export const x = 1\n')
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function stubCli(body) {
  const id = ++seq
  const marker = path.join(scratch, `spawned-${id}.txt`)
  const args = path.join(scratch, `args-${id}.json`)
  const file = path.join(scratch, `cli-${id}.mjs`)
  writeFileSync(
    file,
    `import { writeFileSync } from 'node:fs'\n` +
      `writeFileSync(${JSON.stringify(marker)}, 'x')\n` +
      `writeFileSync(${JSON.stringify(args)}, JSON.stringify(process.argv.slice(2)))\n` +
      body,
  )
  return { file, marker, args }
}

function reportStub(payload) {
  return stubCli(`process.stdout.write(${JSON.stringify(JSON.stringify(payload))})\n`)
}

function runHook(input, { cli, env = {} } = {}) {
  const home = path.join(scratch, `home-${++seq}`)
  const childEnv = { ...process.env, PRICECHECK_HOME: home, PRICECHECK_CLI: cli?.file ?? '' }
  delete childEnv.PRICECHECK_HOOK
  Object.assign(childEnv, env)
  const started = Date.now()
  const r = spawnSync('node', [HOOK], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    timeout: 20000,
    env: childEnv,
  })
  return { status: r.status, stdout: r.stdout, ms: Date.now() - started }
}

const edit = (file_path, tool_name = 'Edit') => ({
  session_id: 's-1',
  cwd: repo,
  tool_name,
  tool_input: { file_path },
})

const twoPages = {
  mode: 'static',
  against: 'HEAD',
  ms: 12,
  changed: [
    {
      page: 'src/views/SignIn.vue',
      before: 40,
      after: 52,
      delta: 12,
      files: [
        { file: 'src/views/SignIn.vue', delta: 9, units: { word: 9, control: 2 } },
        { file: 'src/components/Footer.vue', delta: 3, units: { word: 3 } },
      ],
    },
    {
      page: 'src/views/Home.vue',
      before: 52,
      after: 45,
      delta: -7,
      files: [{ file: 'src/views/Home.vue', delta: -7, units: { word: -6, control: -1 } }],
    },
  ],
}

describe('price tag hook', () => {
  test('a non-UI file prints nothing and never runs the CLI', () => {
    const cli = reportStub(twoPages)
    const r = runHook(edit(path.join(repo, 'src', 'util', 'format.ts')), { cli })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    expect(existsSync(cli.marker)).toBe(false)
  })

  test('a read tool and a malformed payload print nothing', () => {
    const cli = reportStub(twoPages)
    expect(runHook(edit(signIn, 'Read'), { cli }).stdout).toBe('')
    expect(runHook('{not json', { cli })).toEqual({ status: 0, stdout: '', ms: expect.any(Number) })
    expect(existsSync(cli.marker)).toBe(false)
  })

  test('a UI file runs the CLI against HEAD with the repo-relative file', () => {
    const cli = reportStub(twoPages)
    runHook(edit(signIn, 'Write'), { cli })
    const [cmd, against, head, files, rel, json, root, rootPath] = JSON.parse(readFileSync(cli.args, 'utf8'))
    expect([cmd, against, head, files, rel, json, root]).toEqual([
      'diff',
      '--against',
      'HEAD',
      '--files',
      'src/views/SignIn.vue',
      '--json',
      '--root',
    ])
    expect(path.resolve(rootPath)).toBe(path.resolve(realpathSync.native(repo)))
  })

  test('a locale catalog runs the CLI too', () => {
    const cli = reportStub({ changed: [] })
    const r = runHook(edit(path.join(repo, 'src', 'locales', 'en.json')), { cli })
    expect(existsSync(cli.marker)).toBe(true)
    expect(r.stdout).toBe('')
  })

  test('a reported change prints the exact two-page context', () => {
    const cli = reportStub(twoPages)
    const r = runHook(edit(signIn), { cli })
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: [
          'Price check: this edit makes src/views/SignIn.vue 40 -> 52 points (+12: +9 words, +2 controls in src/views/SignIn.vue).',
          'Price check: this edit makes src/views/Home.vue 52 -> 45 points, cheaper (-7: -6 words, -1 control in src/views/Home.vue).',
          'Every point is attention the person pays; cheaper wins. pricecheck page src/views/SignIn.vue shows the whole bill.',
        ].join('\n'),
      },
    })
  })

  test('a reported change records one tag advice for the first page shown', () => {
    const cli = reportStub(twoPages)
    const home = path.join(scratch, 'advice-home')
    const r = runHook(edit(signIn, 'Write'), { cli, env: { PRICECHECK_HOME: home } })
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout).hookSpecificOutput.hookEventName).toBe('PostToolUse')
    const rows = readFileSync(path.join(home, 'advice.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'tag', page: 'src/views/SignIn.vue', points: 52, claim: 'tag src/views/SignIn.vue +12' })
  })

  test('a tag for a page that now prices at zero points records no advice', () => {
    const cli = reportStub({ changed: [{ page: 'src/views/SignIn.vue', before: 5, after: 0, delta: -5, files: [{ file: 'src/views/SignIn.vue', delta: -5, units: { word: -5 } }] }] })
    const home = path.join(scratch, 'zero-home')
    const r = runHook(edit(signIn, 'Write'), { cli, env: { PRICECHECK_HOME: home } })
    expect(r.status).toBe(0)
    expect(existsSync(path.join(home, 'advice.jsonl'))).toBe(false)
  })

  test('more than three changed pages show two, then a count, within four lines', () => {
    const page = (name, delta) => ({
      page: name,
      before: 10,
      after: 10 + delta,
      delta,
      files: [{ file: name, delta, units: { word: delta } }],
    })
    const cli = reportStub({ changed: [page('a.vue', 1), page('b.vue', 2), page('c.vue', 3), page('d.vue', 4)] })
    const text = JSON.parse(runHook(edit(signIn), { cli }).stdout).hookSpecificOutput.additionalContext
    const lines = text.split('\n')
    expect(lines).toHaveLength(4)
    expect(lines[2]).toBe('+2 more pages')
    expect(lines[3]).toContain('pricecheck page a.vue shows the whole bill.')
  })

  test('a page whose price did not move prints nothing', () => {
    const cli = reportStub({ changed: [{ page: 'src/views/SignIn.vue', before: 40, after: 40, delta: 0, files: [] }] })
    expect(runHook(edit(signIn), { cli }).stdout).toBe('')
  })

  test('the CLI is given a budget that ends before the hook kills it', () => {
    const cli = reportStub(twoPages)
    runHook(edit(signIn, 'Write'), { cli })
    const args = JSON.parse(readFileSync(cli.args, 'utf8'))
    const budget = Number(args[args.indexOf('--budget-ms') + 1])
    expect(budget).toBeGreaterThan(0)
    expect(budget).toBeLessThan(6000)
  })

  test('a partial report says how many pages were priced and that the rest were not', () => {
    const cli = reportStub({ ...twoPages, partial: { priced: 40, of: 306 } })
    const text = JSON.parse(runHook(edit(signIn, 'Write'), { cli }).stdout).hookSpecificOutput.additionalContext
    expect(text).toContain('Price check: priced 40 of 306 pages in the time allowed; the other 266 are not priced.')
    expect(text).toContain('src/views/SignIn.vue 40 -> 52')
  })

  test('a partial report with no change found still speaks', () => {
    const cli = reportStub({ mode: 'static', against: 'HEAD', changed: [], partial: { priced: 0, of: 306 } })
    const text = JSON.parse(runHook(edit(signIn, 'Write'), { cli }).stdout).hookSpecificOutput.additionalContext
    expect(text).toContain('priced 0 of 306 pages')
    expect(text).toContain('no change found in them')
  })

  test('a CLI error prints nothing and exits 0', () => {
    const cli = stubCli(`process.stderr.write('boom'); process.exit(3)\n`)
    const r = runHook(edit(signIn), { cli })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })

  test('a CLI that runs past six seconds is killed and the hook prints nothing', () => {
    const cli = stubCli(`setTimeout(() => {}, 60000)\n`)
    const r = runHook(edit(signIn), { cli })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.ms).toBeLessThan(9000)
  }, 20000)

  test('PRICECHECK_HOOK=off does nothing', () => {
    const cli = reportStub(twoPages)
    const r = runHook(edit(signIn), { cli, env: { PRICECHECK_HOOK: 'off' } })
    expect(r.stdout).toBe('')
    expect(existsSync(cli.marker)).toBe(false)
  })

  test('a hook-off file in PRICECHECK_HOME does nothing', () => {
    const cli = reportStub(twoPages)
    const home = path.join(scratch, 'switched-off')
    mkdirSync(home, { recursive: true })
    writeFileSync(path.join(home, 'hook-off'), '')
    const r = runHook(edit(signIn), { cli, env: { PRICECHECK_HOME: home } })
    expect(r.stdout).toBe('')
    expect(existsSync(cli.marker)).toBe(false)
  })
})
