// server/tests/cli-limit-reset.test.ts — reading the CLI's /limit-reset answer off its screen, and
// driving a CLI through it without holding the daemon's thread.
//
// The CLI draws with cursor moves, so the screen text AgentHydra reads has its spaces missing and
// other screen content run into the answer. The first real run (2026-09-30, instance #83) came
// back as "resetisn'tavailablerightnow.◐ medium · /effort" and was shown to the owner verbatim.
// These pin that such text still maps to the right outcome, a clean sentence and a readable date.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyLimitResetScreen, dateAfter, runCliLimitReset } from '../src/core/cli-limit-reset'

test('the real space-less "not available" screen maps to unavailable with a clean sentence', () => {
  const hit = classifyLimitResetScreen(
    "❯ /limit-reset \n  ⎿  Asession-limitresetisn'tavailablerightnow. · ← for agents◐ medium · /effort",
  )
  expect(hit?.outcome).toBe('unavailable')
  expect(hit?.say).toBe("A reset isn't available for this account right now.")
})

test('a spent weekly reset maps to used, and its date is respaced', () => {
  const screen = '⎿  Weeklyresetused·availableagainOct7,6pm · ← for agents'
  expect(classifyLimitResetScreen(screen)?.outcome).toBe('used')
  expect(dateAfter(screen)).toBe('Oct 7, 6pm')
})

test('a reset that went through maps to reset', () => {
  const screen =
    '⎿  Session limit reset · next reset available Oct 14 · your weekly limit still applies'
  expect(classifyLimitResetScreen(screen)?.outcome).toBe('reset')
  expect(dateAfter(screen)).toBe('Oct 14')
})

// Whole runs use a stand-in CLI on a real pseudo-terminal. The stand-in shows a prompt, echoes what is typed, answers `/limit-reset` with the banked reset's
// question, and writes which answer it got ("yes" or "no") to a file. Each run waits out the real
// CLI's six-second start screen, so these take about eight seconds apiece.

const root = mkdtempSync(join(tmpdir(), 'ah-limit-reset-'))
const claudeWas = process.env.AGENTHYDRA_CLAUDE_PATH

const STAND_IN = `
const { appendFileSync } = require('node:fs')
const said = (k) => appendFileSync(process.env.CLAUDE_CONFIG_DIR + '/answers.txt', k + '\\n')
process.stdout.write('Claude Code\\r\\n> Try "how does this repo work"\\r\\n')
process.stdin.setRawMode(true)
let line = ''
let asking = false
process.stdin.on('data', (d) => {
  for (const ch of d.toString()) {
    if (ch === '\\x03') process.exit(0)
    if (asking) {
      if (ch === '\\x1b') { said('no'); asking = false; process.stdout.write('\\r\\nKept.\\r\\n') }
      if (ch === '\\r') { said('yes'); asking = false; process.stdout.write('\\r\\nLimits reset · next reset available Oct 14\\r\\n') }
      continue
    }
    if (ch === '\\r') {
      if (line === '/limit-reset') {
        asking = true
        process.stdout.write('\\r\\nUse your reset? 2 left · use by Oct 14\\r\\n> Yes, use my reset\\r\\n  No, keep it\\r\\n')
      }
      line = ''
    } else {
      line += ch
      process.stdout.write(ch)
    }
  }
})
`

/** On Windows a compiled exe: Bun refuses to hand a .cmd shim the CLI's `{"mcpServers":{}}` argument. */
async function standInCli(): Promise<string> {
  const dir = join(root, 'cli')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'fake.cjs'), STAND_IN)
  if (process.platform === 'win32') {
    const exe = join(dir, 'claude.exe')
    const built = Bun.spawn(
      ['bun', 'build', '--compile', `--outfile=${exe}`, join(dir, 'fake.cjs')],
      {
        stdout: 'ignore',
        stderr: 'inherit',
      },
    )
    expect(await built.exited).toBe(0)
    return exe
  }
  writeFileSync(join(dir, 'claude'), '#!/bin/sh\nexec bun "$(dirname "$0")/fake.cjs" "$@"\n')
  chmodSync(join(dir, 'claude'), 0o755)
  return join(dir, 'claude')
}

beforeAll(async () => {
  process.env.AGENTHYDRA_CLAUDE_PATH = await standInCli()
}, 60_000)
afterAll(() => {
  if (claudeWas === undefined) delete process.env.AGENTHYDRA_CLAUDE_PATH
  else process.env.AGENTHYDRA_CLAUDE_PATH = claudeWas
})

let accounts = 0
function account(): { dir: string; answers: () => string[] } {
  const dir = join(root, `account-${++accounts}`)
  mkdirSync(dir, { recursive: true })
  const answers = () => {
    try {
      return readFileSync(join(dir, 'answers.txt'), 'utf8').split('\n').filter(Boolean)
    } catch {
      return []
    }
  }
  return { dir, answers }
}

// A check must never spend: it backs out of the question. A confirm answers it once.
test.each([
  {
    confirm: false,
    outcome: 'available',
    message: 'A reset is available (2 left, use by Oct 14). It was not used.',
    answers: ['no'],
  },
  {
    confirm: true,
    outcome: 'reset',
    message: 'Limits reset. Next one available Oct 14.',
    answers: ['yes'],
  },
])(
  'confirm: $confirm answers the question "$answers" and reports $outcome',
  async (c) => {
    const a = account()
    const r = await runCliLimitReset(a.dir, { confirm: c.confirm })
    expect({ outcome: r.outcome, message: r.message, ok: r.ok }).toEqual({
      outcome: c.outcome as typeof r.outcome,
      message: c.message,
      ok: c.confirm,
    })
    expect(a.answers()).toEqual([...c.answers])
  },
  40_000,
)

// 2026-10-11: starting claude.exe held the daemon's only thread for seconds at a time, and the tray
// watchdog kills a daemon that leaves /api/health unanswered. Here a process start holds the thread
// that asks for it for two seconds, as it does on a loaded Windows PC; the run must not ask from this one.
test("a run starts and drives the CLI without holding the daemon's thread", async () => {
  const a = account()
  const realSpawn = Bun.spawn
  ;(Bun as unknown as { spawn: unknown }).spawn = (...args: Parameters<typeof Bun.spawn>) => {
    Bun.sleepSync(2000)
    return realSpawn(...args)
  }
  let last = performance.now()
  let longestGap = 0
  const tick = setInterval(() => {
    const now = performance.now()
    longestGap = Math.max(longestGap, now - last)
    last = now
  }, 20)
  try {
    const r = await runCliLimitReset(a.dir, { confirm: false })
    expect(r.outcome).toBe('available')
  } finally {
    clearInterval(tick)
    ;(Bun as unknown as { spawn: unknown }).spawn = realSpawn
  }
  expect(longestGap).toBeLessThan(1000)
}, 40_000)
