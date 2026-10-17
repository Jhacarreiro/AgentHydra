import { describe, expect, test } from 'bun:test'
import { type Composer, type ComposeRequest, composeWithFallback, sdkComposer } from '../../src/engine/advisor-compose'
import type { QueryImpl } from '../../src/engine/chat-runtime'

const ok = (result: string) => ({ type: 'result', subtype: 'success', is_error: false, result })
const failed = (errors: string[]) => ({ type: 'result', subtype: 'error_during_execution', is_error: true, errors })

function replying(messages: unknown[], seen: { env?: Record<string, string | undefined> } = {}): QueryImpl {
  return ((params: { options: { env?: Record<string, string | undefined> } }) => {
    seen.env = params.options.env
    return (async function* () {
      for (const m of messages) yield m
    })()
  }) as unknown as QueryImpl
}

const req = { system: 'S', prompt: 'P', cwd: 'C:/tmp' }
const compose = (queryImpl: QueryImpl, configDir: string | null) =>
  sdkComposer(queryImpl, {}, () => null)({ ...req, configDir })

describe('sdkComposer', () => {
  test('a successful reply gives its text', async () => {
    expect(await compose(replying([ok('Duke says hi')]), null)).toEqual({ text: 'Duke says hi' })
  })

  test('an empty successful reply gives the reason', async () => {
    expect(await compose(replying([ok('  ')]), null)).toEqual({ reason: 'the model replied with empty text' })
  })

  test('an error result gives its subtype and error text', async () => {
    const r = await compose(replying([failed(['boom'])]), null)
    expect(r).toEqual({ reason: 'error_during_execution with an error: boom' })
  })

  test('no result message gives the reason', async () => {
    expect(await compose(replying([]), null)).toEqual({ reason: 'the CLI ended without a result' })
  })

  test('a thrown error gives the reason', async () => {
    const throws = (() => {
      throw new Error('spawn failed')
    }) as unknown as QueryImpl
    expect(await compose(throws, null)).toEqual({ reason: 'the CLI failed: spawn failed' })
  })

  test('the account folder is set in the CLI environment, or removed for the default login', async () => {
    const seen: { env?: Record<string, string | undefined> } = {}
    await sdkComposer(replying([ok('x')], seen), { CLAUDE_CONFIG_DIR: 'C:/old' }, () => null)({ ...req, configDir: 'D:/acc' })
    expect(seen.env?.CLAUDE_CONFIG_DIR).toBe('D:/acc')
    await sdkComposer(replying([ok('x')], seen), { CLAUDE_CONFIG_DIR: 'C:/old' }, () => null)({ ...req, configDir: null })
    expect(seen.env && 'CLAUDE_CONFIG_DIR' in seen.env).toBe(false)
  })
})

function scripted(failing: string[]): { compose: Composer; asked: (string | null)[] } {
  const asked: (string | null)[] = []
  const compose: Composer = async (r: ComposeRequest) => {
    asked.push(r.configDir)
    return failing.includes(r.configDir ?? '') ? { reason: `${r.configDir} failed` } : { text: `from ${r.configDir}` }
  }
  return { compose, asked }
}

describe('composeWithFallback', () => {
  test('the first account answers: no other account is picked', async () => {
    const { compose, asked } = scripted([])
    const spy = { called: false }
    const r = await composeWithFallback(compose, req, 'A', async () => {
      spy.called = true
      return 'B'
    })
    expect(r).toEqual({ text: 'from A' })
    expect(asked).toEqual(['A'])
    expect(spy.called).toBe(false)
  })

  test('the first fails: one other account the picker names answers', async () => {
    const { compose, asked } = scripted(['A'])
    const r = await composeWithFallback(compose, req, 'A', async () => 'B')
    expect(r).toEqual({ text: 'from B' })
    expect(asked).toEqual(['A', 'B'])
  })

  test('the picker naming the same account is not tried again', async () => {
    const { compose, asked } = scripted(['A'])
    const r = await composeWithFallback(compose, req, 'A', async () => 'A')
    expect(r).toEqual({ reason: 'A failed' })
    expect(asked).toEqual(['A'])
  })

  test('no other account to pick gives the first reason', async () => {
    const { compose, asked } = scripted(['A'])
    expect(await composeWithFallback(compose, req, 'A', async () => null)).toEqual({ reason: 'A failed' })
    expect(asked).toEqual(['A'])
  })

  test('both fail: both reasons are reported', async () => {
    const { compose } = scripted(['A', 'B'])
    expect(await composeWithFallback(compose, req, 'A', async () => 'B')).toEqual({
      reason: 'A failed; then another account: B failed',
    })
  })
})
