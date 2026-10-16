import { afterAll, afterEach, expect, spyOn, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cliPlanLabel } from '../src/core/cli-instances'

const root = mkdtempSync(join(tmpdir(), 'ah-plan-cache-'))
let sequence = 0
const spies: ReturnType<typeof spyOn>[] = []
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

function account(plan: string | null = 'pro') {
  const dir = join(root, String(sequence++))
  mkdirSync(dir)
  const path = join(dir, '.credentials.json')
  writeFileSync(path, JSON.stringify({ claudeAiOauth: { subscriptionType: plan } }))
  return { dir, path }
}

function stableReadClock() {
  const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000)
  spies.push(clock)
}

test('unchanged plan reads parse credentials once, including valid files without a plan', () => {
  stableReadClock()
  for (const plan of ['pro', null]) {
    const { dir } = account(plan)
    const parses = spyOn(JSON, 'parse')
    spies.push(parses)
    for (let i = 0; i < 20; i++) expect(cliPlanLabel(dir)).toBe(plan ? 'Pro' : null)
    expect(parses).toHaveBeenCalledTimes(1)
    parses.mockRestore()
    spies.pop()
  }
})

test('recent file timestamps are re-read until a stable parse is obtained', () => {
  const { dir, path } = account()
  const st = statSync(path)
  const clock = spyOn(Date, 'now').mockReturnValue(Math.max(st.mtimeMs, st.ctimeMs) + 100)
  spies.push(clock)
  const parses = spyOn(JSON, 'parse')
  spies.push(parses)
  expect(cliPlanLabel(dir)).toBe('Pro')
  expect(cliPlanLabel(dir)).toBe('Pro')
  expect(parses).toHaveBeenCalledTimes(2)
  clock.mockReturnValue(Math.max(st.mtimeMs, st.ctimeMs) + 2_000)
  expect(cliPlanLabel(dir)).toBe('Pro')
  expect(cliPlanLabel(dir)).toBe('Pro')
  expect(parses).toHaveBeenCalledTimes(3)
})

test('changed credentials update the label and rate-limit tier immediately', () => {
  const { dir, path } = account()
  expect(cliPlanLabel(dir)).toBe('Pro')
  writeFileSync(
    path,
    JSON.stringify({
      claudeAiOauth: {
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_20x',
      },
    }),
  )
  expect(cliPlanLabel(dir)).toBe('Max 20×')
})

test('atomic replacement invalidates even when length and modification time are unchanged', () => {
  stableReadClock()
  const { dir, path } = account()
  expect(cliPlanLabel(dir)).toBe('Pro')
  const before = statSync(path)
  const replacement = join(dir, 'replacement.json')
  writeFileSync(replacement, JSON.stringify({ claudeAiOauth: { subscriptionType: 'max' } }))
  utimesSync(replacement, before.atime, before.mtime)
  expect(statSync(replacement).size).toBe(before.size)
  renameSync(replacement, path)
  expect(cliPlanLabel(dir)).toBe('Max')
})

test('removed, malformed and repaired credentials never return a stale plan', () => {
  const { dir, path } = account()
  expect(cliPlanLabel(dir)).toBe('Pro')
  rmSync(path)
  expect(cliPlanLabel(dir)).toBeNull()
  writeFileSync(path, '{malformed')
  expect(cliPlanLabel(dir)).toBeNull()
  writeFileSync(path, JSON.stringify({ claudeAiOauth: { subscriptionType: 'free' } }))
  expect(cliPlanLabel(dir)).toBe('Free')
})

test('the bounded label cache releases old account entries', () => {
  stableReadClock()
  const first = account()
  expect(cliPlanLabel(first.dir)).toBe('Pro')
  for (let i = 0; i < 512; i++) expect(cliPlanLabel(account().dir)).toBe('Pro')
  const parses = spyOn(JSON, 'parse')
  spies.push(parses)
  expect(cliPlanLabel(first.dir)).toBe('Pro')
  expect(parses).toHaveBeenCalledTimes(1)
})
