// server/tests/climayte-launch.test.ts — a new attempt's launch against the fake CLI: the worker no
// longer carries the last attempt's summary line (Desk 2 showed 'finished (...)' under a running chat).

import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  climayteCancel,
  climayteJournal,
  climayteRun,
  climayteSend,
  climayteWait,
  killsLanded,
  setCliMayteAccountsProvider,
  setCliMayteClaudeCommand,
  startCliMayte,
} from '../src/climayte'
import { PROMPTS, setSpendKit, workers } from '../src/climayte-core'
import { promptTextOf } from '../src/climayte-launch'
import { harnessKit } from './mocks/climayte-kit'
import { ATTEMPT_MS } from './mocks/climayte-timing'

setSpendKit(harnessKit)

describe('a new attempt does not show the summary line of the one before it', () => {
  const root = mkdtempSync(join(tmpdir(), 'ah-climayte-launch-'))
  const cwd = join(root, 'work')
  const slowDir = join(root, 'acct-slow')
  for (const d of [cwd, slowDir]) mkdirSync(d, { recursive: true })
  writeFileSync(join(slowDir, 'fake-slow'), '')
  const stale = 'finished (3 turns; session so far $1.00)'
  let group = ''

  afterAll(async () => {
    if (group) climayteCancel({ group })
    await killsLanded()
    setCliMayteClaudeCommand(null)
    setCliMayteAccountsProvider(null)
    rmSync(root, { recursive: true, force: true })
  })

  test(
    'a steered attempt starts with no line from the attempt it stopped',
    async () => {
      setCliMayteClaudeCommand([process.execPath, join(import.meta.dir, 'mocks', 'fake-claude.ts')])
      setCliMayteAccountsProvider(() => [
        { id: 'slow-1', num: 7, name: 'slow', configDir: slowDir, sessionPct: 0, weekPct: 0 },
      ])
      startCliMayte()
      const run = climayteRun({
        tasks: [
          {
            prompt: 'a slow task',
            cwd,
            title: 'launch activity',
            model: 'sonnet',
            effort: 'medium',
            ownerWords: 'a new attempt starts with no stale summary line',
          },
        ],
      })
      group = run.group
      const id = run.workers[0]?.id as string
      const w = () => workers.get(id)
      const deadline = Date.now() + ATTEMPT_MS
      const started = () => {
        const log = w()?.attempts.at(-1)?.log
        return !!log && existsSync(log) && readFileSync(log, 'utf8').includes('"subtype":"init"')
      }
      while (!started() && Date.now() < deadline) await Bun.sleep(50)

      w()!.lastActivity = stale
      expect(climayteSend(id, 'STEER NOW', { urgent: true })).toMatchObject({
        ok: true,
        urgent: true,
      })
      const next = Date.now() + ATTEMPT_MS
      while ((w()?.attempts.length ?? 0) < 2 && Date.now() < next) await climayteWait({ id }, 50)

      expect(w()?.attempts.length).toBe(2)
      expect(climayteJournal({ id }).some((e) => e.event === 'follow-up-delivered')).toBe(true)
      expect(w()?.lastActivity).not.toBe(stale)
    },
    2 * ATTEMPT_MS + 10_000,
  )
})

const envelope = (text: string) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })
const lineText = (raw: string): string => JSON.parse(raw.trim()).message.content[0].text

describe('a relaunch hands the previous message on as plain text', () => {
  const root = mkdtempSync(join(tmpdir(), 'ah-climayte-prompt-'))
  const cwd = join(root, 'work')
  const slowDir = join(root, 'acct-slow')
  for (const d of [cwd, slowDir]) mkdirSync(d, { recursive: true })
  writeFileSync(join(slowDir, 'fake-slow'), '')
  let group = ''

  afterAll(async () => {
    if (group) climayteCancel({ group })
    await killsLanded()
    setCliMayteClaudeCommand(null)
    setCliMayteAccountsProvider(null)
    rmSync(root, { recursive: true, force: true })
  })

  test(
    'an attempt stopped before its session started is relaunched with its message, not an envelope',
    async () => {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: 'win32' })
      try {
        setCliMayteClaudeCommand([
          process.execPath,
          join(import.meta.dir, 'mocks', 'fake-claude.ts'),
        ])
        setCliMayteAccountsProvider(() => [
          { id: 'slow-1', num: 7, name: 'slow', configDir: slowDir, sessionPct: 0, weekPct: 0 },
        ])
        startCliMayte()
        const run = climayteRun({
          tasks: [
            {
              prompt: 'a slow task',
              cwd,
              title: 'prompt envelope',
              model: 'sonnet',
              effort: 'medium',
              ownerWords: 'a relaunch carries the message as plain text',
            },
          ],
        })
        group = run.group
        const id = run.workers[0]?.id as string
        const first = join(PROMPTS, `${id}-0.txt`)
        const second = join(PROMPTS, `${id}-1.txt`)
        const deadline = Date.now() + ATTEMPT_MS
        while (!existsSync(first) && Date.now() < deadline) await Bun.sleep(50)

        expect(climayteSend(id, 'STEER NOW', { urgent: true })).toMatchObject({
          ok: true,
          urgent: true,
        })
        const next = Date.now() + ATTEMPT_MS
        while (!existsSync(second) && Date.now() < next) await climayteWait({ id }, 50)

        expect(existsSync(second)).toBe(true)
        const message = lineText(readFileSync(first, 'utf8'))
        const relaunch = lineText(readFileSync(second, 'utf8'))
        expect(relaunch.startsWith(message)).toBe(true)
        expect(relaunch).not.toContain('"type":"user"')
      } finally {
        if (platform) Object.defineProperty(process, 'platform', platform)
      }
    },
    2 * ATTEMPT_MS + 10_000,
  )
})

describe('promptTextOf reads a prompt file as its message', () => {
  test('a double-wrapped stream-json user line decodes to the message', () => {
    const plain = 'Check the ledger totals for March.'
    expect(promptTextOf(`${envelope(envelope(plain))}\n`)).toBe(plain)
  })

  test('a plain-text prompt file is unchanged', () => {
    const plain = 'Check the ledger totals for March.'
    expect(promptTextOf(`${plain}\n`)).toBe(plain)
  })

  test('JSON among other words is not an envelope', () => {
    const text = `Fix the parser for ${envelope('x')} inputs.`
    expect(promptTextOf(text)).toBe(text)
  })
})
