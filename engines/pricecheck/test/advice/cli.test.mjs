import './lessons-home.mjs'
import { afterEach, beforeEach, describe as group, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run } from '../../lib/advice/cli.mjs'
import { adviceFile, readRows, recordAdvice } from '../../lib/advice/log.mjs'

const ROOT = path.resolve('C:/Users/me/Projects/example-shop')
let home
let previous

beforeEach(() => {
  previous = process.env.PRICECHECK_HOME
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pricecheck-advice-cli-'))
  process.env.PRICECHECK_HOME = home
})

afterEach(() => {
  if (previous === undefined) delete process.env.PRICECHECK_HOME
  else process.env.PRICECHECK_HOME = previous
  fs.rmSync(home, { recursive: true, force: true })
})

async function capture(argv) {
  const lines = []
  const log = console.log
  const err = console.error
  console.log = (...a) => lines.push(a.join(' '))
  console.error = (...a) => lines.push(a.join(' '))
  try {
    const code = await run(argv)
    return { code, out: lines.join('\n') }
  } finally {
    console.log = log
    console.error = err
  }
}

group('advice', () => {
  test('says so when nothing was recorded for the root', async () => {
    const { code, out } = await capture(['advice', '--root', ROOT])
    expect(code).toBe(0)
    expect(out).toContain('no advice recorded')
  })

  test('--json gives the root, a summary, and each advice with its outcomes and feedback', async () => {
    const id = recordAdvice({ kind: 'next', root: ROOT, page: 'src/views/Landing.vue', points: 40, claim: 'trim Landing' })
    const { code, out } = await capture(['advice', '--json', '--root', ROOT])
    expect(code).toBe(0)
    const body = JSON.parse(out)
    expect(Object.keys(body).sort()).toEqual(['advice', 'root', 'summary'])
    expect(body.root).toBe(ROOT)
    expect(body.summary).toMatchObject({ issued: 1, followed: 0, undone: 0, misled: 0, stale: 0, feedback: { wrong: 0, undone: 0, right: 0 } })
    expect(body.advice).toEqual([
      expect.objectContaining({ id, kind: 'next', page: 'src/views/Landing.vue', points: 40, claim: 'trim Landing', outcomes: [], feedback: [] }),
    ])
  })

  test('shows the newest 20 by default and every row with --all', async () => {
    for (let i = 0; i < 25; i++) recordAdvice({ kind: 'diff', root: ROOT, page: `p${i}.vue`, points: i + 1, claim: `c${i}` })
    const limited = JSON.parse((await capture(['advice', '--json', '--root', ROOT])).out)
    expect(limited.advice).toHaveLength(20)
    expect(limited.advice[19].page).toBe('p24.vue')
    expect(limited.summary.issued).toBe(25)
    const all = JSON.parse((await capture(['advice', '--json', '--all', '--root', ROOT])).out)
    expect(all.advice).toHaveLength(25)
  })

  test('human output: one line per advice and a summary line with the bad share', async () => {
    recordAdvice({ kind: 'next', root: ROOT, page: 'src/views/Landing.vue', points: 40, claim: 'trim Landing' })
    const { code, out } = await capture(['advice', '--root', ROOT])
    expect(code).toBe(0)
    const lines = out.split('\n')
    expect(lines[0]).toBe(`advice for ${ROOT}`)
    expect(lines[1]).toMatch(/^[0-9a-f]{8} +next +src\/views\/Landing\.vue +40 pts +no outcome yet +trim Landing$/)
    expect(lines[2]).toBe('1 issued, 0 followed, 0 undone, 0 misled, 0 stale, feedback 0 wrong 0 undone 0 right, 0% bad')
  })
})

group('feedback', () => {
  test('records a verdict on an advice and shows it in advice --json', async () => {
    const id = recordAdvice({ kind: 'next', root: ROOT, page: 'src/views/Landing.vue', points: 40, claim: 'trim Landing' })
    const { code, out } = await capture([
      'feedback', '--verdict', 'wrong', '--claim', 'Landing is not 40 points', '--advice', id, '--page', 'src/views/Landing.vue', '--why', 'the footer is a shared component', '--by', 'owner', '--root', ROOT,
    ])
    expect(code).toBe(0)
    expect(out).toMatch(/^recorded feedback [0-9a-f]{8} \(wrong\) on advice [0-9a-f]{8}$/)
    const row = readRows(adviceFile()).find((r) => r.type === 'feedback')
    expect(row).toMatchObject({ type: 'feedback', adviceId: id, verdict: 'wrong', claim: 'Landing is not 40 points', page: 'src/views/Landing.vue', why: 'the footer is a shared component', by: 'owner', root: ROOT })
    expect(row.id).toMatch(/^[0-9a-f]{8}$/)
    expect(Number.isNaN(Date.parse(row.at))).toBe(false)
    const body = JSON.parse((await capture(['advice', '--json', '--root', ROOT])).out)
    expect(body.advice[0].feedback).toEqual(['wrong'])
    expect(body.summary.feedback.wrong).toBe(1)
  })

  test('a feedback without --advice is kept under the root, not attached to any advice', async () => {
    const { code } = await capture(['feedback', '--verdict', 'right', '--claim', 'the diff was fine', '--root', ROOT])
    expect(code).toBe(0)
    const row = readRows(adviceFile()).find((r) => r.type === 'feedback')
    expect(row).toMatchObject({ verdict: 'right', claim: 'the diff was fine', root: ROOT })
    expect(row).not.toHaveProperty('adviceId')
  })

  test('refuses a verdict other than wrong, undone or right, and writes nothing', async () => {
    const { code, out } = await capture(['feedback', '--verdict', 'meh', '--claim', 'x', '--root', ROOT])
    expect(code).toBe(2)
    expect(out).toContain('--verdict must be wrong, undone or right')
    expect(fs.existsSync(adviceFile())).toBe(false)
  })

  test('refuses a missing claim', async () => {
    const { code, out } = await capture(['feedback', '--verdict', 'wrong', '--root', ROOT])
    expect(code).toBe(2)
    expect(out).toContain('--claim is required')
    expect(fs.existsSync(adviceFile())).toBe(false)
  })

  test('refuses an --advice id this root never recorded', async () => {
    const { code, out } = await capture(['feedback', '--verdict', 'wrong', '--claim', 'x', '--advice', 'deadbeef', '--root', ROOT])
    expect(code).toBe(2)
    expect(out).toContain('no advice deadbeef for this root')
    expect(fs.existsSync(adviceFile())).toBe(false)
  })
})
